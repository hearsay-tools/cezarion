#!/usr/bin/env node
// Keep this fixture standalone: lifecycle tests copy the runner into a temp directory.
import { spawn as watchdogSpawn } from 'node:child_process';
import { writeFileSync as watchdogWritePid } from 'node:fs';
function watchdogStall(prompt) {
  if (!prompt.includes('mock:no-progress')) return false;
  watchdogWritePid('watchdog.pid', String(process.pid));
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
    const leftover = (file) => `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setTimeout(()=>{},20000)`;
    watchdogSpawn(process.execPath, ['-e', leftover('leftover-group.pid')], { stdio: 'ignore' });
    watchdogSpawn(process.execPath, ['-e', leftover('leftover-session.pid')], { stdio: 'ignore', detached: true }).unref();
  }
  return true;
}

// Bundled dry-run mock of `codex app-server` — speaks just enough JSON-RPC 2.0
// JSONL (§3 of agent-event-protocols.md) for the runner wiring test in
// `codex-ui-mapper.test.ts`: initialize/thread/turn handshake, one scripted
// turn with an agentMessage + a commandExecution (with live outputDelta),
// cumulative token usage, then exits on stdin EOF like the real server.
//
// `MOCK_CODEX_IGNORE_EOF=1` switches to the #703 teardown shape instead: the
// server stays deaf to stdin EOF (the CLI hang the EOF watchdog exists for)
// and handles SIGTERM itself, exiting 143 rather than dying from the signal.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

import * as parityGateFs from 'node:fs';

// #401: let the test observe the actual monitoring park before releasing late wire frames.
async function afterParityPark(prompt) {
  const gate = /parity-release=([^\s"\\]+)/.exec(prompt)?.[1];
  if (!gate) throw new Error('post-park scenario requires a release path');
  while (!parityGateFs.existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 10));
}

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
// #505: like the real app-server, any active main-thread turn accepts `turn/steer`.
// Steers accepted by an ordinary scripted turn are read just before it completes:
// a userMessage item (echoing clientUserMessageId as clientId) and an echo reply.
let autonomousTurn = 0;
let activeTurnId = null;
let pendingSteers = [];
let steerEchoSerial = 0;
const emit = (obj) => {
  const ending = (obj.method === 'turn/completed' || obj.method === 'turn/failed') && (!obj.params?.threadId || obj.params.threadId === 'th_mock_1');
  // #486 review: CEZ_MOCK_CODEX_NO_STEER_ECHO=1 admits the steer (RPC result) but never
  // echoes its userMessage, so an accepted-but-unread follow-up can complete the turn.
  if (ending && obj.method === 'turn/completed' && pendingSteers.length && process.env.CEZ_MOCK_CODEX_NO_STEER_ECHO !== '1') {
    const turnId = activeTurnId ?? 'turn_mock_1';
    for (const entry of pendingSteers.splice(0)) {
      const item = { type: 'userMessage', id: `item_user_generic_${++steerEchoSerial}`, clientId: entry.clientId, content: [{ type: 'text', text: entry.text }] };
      write({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item } });
      write({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item } });
      write({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: `item_steer_echo_${steerEchoSerial}`, text: entry.text } } });
    }
  }
  if (ending) { activeTurnId = null; pendingSteers = []; }
  write(obj);
  // #505 review: CEZ_MOCK_CODEX_LATE_START_ACK=1 answers turn/start after the turn completed.
  if (ending && lateStartAck !== undefined) { const id = lateStartAck; lateStartAck = undefined; write({ id, result: { turn: { id: 'turn_mock_1' } } }); }
};
let lateStartAck;
let startSerial = 0;
let resumeAfterAsk = false;
const rl = createInterface({ input: process.stdin });
let echoSerial = 0;
let ciWire;
// #505 steering scenarios: the one turn that accepts `turn/steer`, while it is open.
let steerTurn = null;
let steerSerial = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForMockRelease(fallbackMs) {
  const file = process.env.CEZ_MOCK_RELEASE_FILE;
  if (!file) { if (fallbackMs) await sleep(fallbackMs); return; }
  const deadline = Date.now() + 15_000;
  while (!parityGateFs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('CEZ_MOCK_RELEASE_FILE was not created');
    await sleep(10);
  }
}
const completeSteerTurn = (turnId) => {
  steerTurn = null;
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: turnId, status: 'completed' } } });
};

// #708: requirements shape from Codex's generated ConfigRequirementsReadResponse.
// Retain an invalid requested override to reproduce fallback warnings on later turns.
const managedRequirements = process.env.MOCK_CODEX_REQUIREMENTS
  ? JSON.parse(process.env.MOCK_CODEX_REQUIREMENTS) : null;
let rejectedPermissionOverride = false;
const permissionWarning = () => emit({ method: 'warning', params: { message:
  "Configured value for 'permission_profile' is disallowed by requirements; falling back to required value Managed. DangerFullAccess is not in the allowed set [ReadOnly, WorkspaceWrite]",
} });
const ignoreEof = process.env.MOCK_CODEX_IGNORE_EOF === '1';
if (ignoreEof) {
  process.on('SIGTERM', () => process.exit(143));
  // Keep the event loop alive so EOF alone can never end the process.
  setInterval(() => {}, 60_000);
}

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(msg)}\n`);
  if (msg.id === 'ask-bad-1' && msg.error) {
    // The runner rejected the malformed payload with -32602, as it must. A real
    // app-server carries on from there, so the turn still completes — a mock
    // that went silent here would make harness parity R4 pass by hanging
    // instead of by ending the turn.
    emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  } else if (msg.id === 'ask-1' && msg.result) {
    const answer = msg.result.answers?.library?.answers;
    const freeText = msg.result.answers?.first?.answers;
    if (resumeAfterAsk && Array.isArray(answer) && answer[0] === 'Vitest') {
      resumeAfterAsk = false;
      const text = 'Implemented the choice.\nCEZ:DONE';
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_answer', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_answer', delta: text } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_answer', text } } });
    }
    emit((Array.isArray(answer) && answer[0] === 'Vitest') || (Array.isArray(freeText) && freeText[0] === 'Use sensible defaults')
      ? { method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } }
      : { method: 'turn/failed', params: { turn: { id: 'turn_mock_1', status: 'failed' }, error: { message: 'bad answer' } } });
  } else if (msg.method === 'turn/steer') {
    // #505 ambiguity: the transport dies with the steer unanswered.
    if (process.env.CEZ_MOCK_CODEX_EXIT_ON_STEER === '1') process.exit(1);
    const turn = steerTurn;
    if (!turn && activeTurnId && msg.params?.expectedTurnId === activeTurnId) {
      pendingSteers.push({ clientId: msg.params?.clientUserMessageId ?? null, text: msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '' });
      emit({ id: msg.id, result: {} });
      return;
    }
    if (!turn || msg.params?.expectedTurnId !== turn.id) {
      emit({ id: msg.id, error: { code: -32600, message: 'no active turn matching expectedTurnId' } });
      return;
    }
    const text = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
    if (turn.strand) {
      // The turn completes first, then the server acknowledges the steer: nothing reads it.
      completeSteerTurn(turn.id);
      emit({ id: msg.id, result: {} });
      return;
    }
    if (turn.race) {
      // The turn ends before the server processes the steer: a definitive mismatch.
      completeSteerTurn(turn.id);
      emit({ id: msg.id, error: { code: -32600, message: 'no active turn matching expectedTurnId' } });
      return;
    }
    turn.steered.push({ clientId: msg.params?.clientUserMessageId ?? null, text });
    emit({ id: msg.id, result: {} });
  } else if (msg.method === 'initialize') {
    emit({ id: msg.id, result: { userAgent: 'mock-codex/0.0.0' } });
  } else if (msg.method === 'configRequirements/read') {
    if (process.env.MOCK_CODEX_REQUIREMENTS_ERROR) {
      emit({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
    } else {
      emit({ id: msg.id, result: process.env.MOCK_CODEX_REQUIREMENTS_MALFORMED
        ? { requirements: 'invalid' } : { requirements: managedRequirements } });
    }
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    if (process.env.CEZ_MOCK_CI_PR) { const { probeCiTool } = await import('./mock-ci-tool.mjs'); await probeCiTool('codex', msg.params); }
    ciWire = msg.params;
    const expectedSandbox = process.env.CEZ_CODEX_NETWORK === '0' ? 'workspace-write' : 'danger-full-access';
    rejectedPermissionOverride = managedRequirements !== null && msg.params?.sandbox !== undefined;
    if (rejectedPermissionOverride) permissionWarning();
    const unknownRequirements = process.env.MOCK_CODEX_REQUIREMENTS_ERROR || process.env.MOCK_CODEX_REQUIREMENTS_MALFORMED;
    if ((!managedRequirements && !unknownRequirements && msg.params?.sandbox !== expectedSandbox) || msg.params?.approvalPolicy !== undefined) {
      emit({ id: msg.id, error: { code: -32602, message: `expected ${expectedSandbox} managed permissions` } });
      return;
    }
    if (process.argv.includes('sandbox_workspace_write.network_access=true')) {
      emit({ id: msg.id, error: { code: -32602, message: 'workspace-write override is obsolete in full-access mode' } });
      return;
    }
    // Codex retains an allowed persisted profile unless the client explicitly
    // selects another (thread_processor::load_and_apply_persisted_resume_metadata).
    if (msg.method === 'thread/resume' && process.env.MOCK_CODEX_PERSISTED_PROFILE === ':read-only' && msg.params?.permissions && msg.params.permissions !== ':read-only') {
      emit({ id: msg.id, error: { code: -32602, message: 'client widened a persisted read-only profile' } });
      return;
    }
    const sandbox = managedRequirements
      ? { type: 'readOnly', networkAccess: process.env.MOCK_CODEX_MANAGED_NETWORK === '1' }
      : msg.params?.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
      : { type: 'workspaceWrite', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    if (msg.method === 'thread/start') {
      emit({ method: 'thread/started', params: { thread: { id: 'th_mock_1' } } });
      emit({ id: msg.id, result: { thread: { id: 'th_mock_1' }, sandbox } });
    } else if (process.env.MOCK_CODEX_REJECT_RESUME === '1') {
      emit({ id: msg.id, error: { code: -32603, message: `no rollout found for thread id ${msg.params?.threadId ?? ''}` } });
      rl.close();
    } else {
      emit({ id: msg.id, result: { thread: { id: msg.params?.threadId }, sandbox } });
    }
  } else if (msg.method === 'turn/start') {
    const openingCrashText = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
    if (openingCrashText.includes('mock:crash-stderr-pre-ack')) {
      const { crashWithStderr } = await import('./mock-runner-crash.mjs');
      crashWithStderr(openingCrashText, '{"method":"turn/started","params":');
      return;
    }
    if (rejectedPermissionOverride) permissionWarning();
    activeTurnId = 'turn_mock_1';
    // owned-input-delivery.testkit.ts patches the exact `emit(...)` line below; keep it verbatim.
    if (process.env.CEZ_MOCK_CODEX_LATE_START_ACK === '1' && startSerial++ > 0) lateStartAck = msg.id; else {
    emit({ id: msg.id, result: { turn: { id: 'turn_mock_1' } } });
    }
    const turnText = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
    let silent;
    if (turnText.includes('mock:silent-tail') || turnText.includes('Your last turn ended without a message to the user.')) {
      silent = await import('./mock-silent-tail.mjs');
      silent.noteSilentTailPrompt(turnText);
      if (silent.isAckOnlyNudge(turnText)) return;
      if (silent.isLateTurnStartNudge(turnText)) await waitForMockRelease(silent.LATE_REPLY_MS);
      else if (silent.isLateNudge(turnText)) await silent.sleep(silent.LATE_REPLY_MS);
    }
    if (!turnText.includes('mock:no-progress-ack-only')) {
    emit({ method: 'turn/started', params: { turn: { id: 'turn_mock_1', status: 'inProgress', items: [] } } });
    }
    if (silent?.isLateTurnStartNudge(turnText)) await silent.sleep(silent.LATE_TURN_START_HOLD_MS);
    // The real app-server records the turn's own input as a userMessage item,
    // echoing clientUserMessageId as clientId (probe 0.155.1, #505).
    const opening = { type: 'userMessage', id: `item_user_open_${++steerEchoSerial}`, clientId: msg.params?.clientUserMessageId ?? null, content: [{ type: 'text', text: turnText }] };
    if (process.env.CEZ_MOCK_CODEX_NO_USER_ITEM !== '1') {
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: opening } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: opening } });
    }
    if (turnText.includes('mock:crash-stderr')) {
      const { crashWithStderr } = await import('./mock-runner-crash.mjs');
      await new Promise(resolve => setTimeout(resolve, 30));
      if (crashWithStderr(turnText, '{"method":"item/commandExecution/outputDelta","params":')) return;
    }
    if (turnText.includes('mock:autonomous') || turnText.startsWith('Continue working autonomously until the task is fully complete.')) {
      const { autonomousReply } = await import('./mock-autonomous.mjs');
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: `autonomous-${++autonomousTurn}`, text: autonomousReply(turnText) } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:silent-tail') || turnText.includes('mock:tool-tail') || turnText.includes('Your last turn ended without a message to the user.')) {
      const silent = await import('./mock-silent-tail.mjs');
      silent.noteSilentTailPrompt(turnText);
      if (silent.isFinalMessageNudge(turnText)) {
        const kind = silent.finalMessageNudgeKind();
        if (kind === 'silent') {
          emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'reasoning', id: 'silent-nudge-rsn', summary: silent.SILENT_TAIL_REASONING, content: silent.SILENT_TAIL_REASONING } } });
        } else {
          if (kind === 'slow-done') {
            emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'silent-nudge-prefix', text: silent.SLOW_DONE_PREFIX } } });
            await silent.sleep(silent.SLOW_DONE_TAIL_MS);
          }
          const text = kind === 'standing' ? silent.FINAL_MESSAGE_STANDING : silent.SILENT_TAIL_DONE;
          emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'silent-nudge-done', text } } });
        }
        emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
        return;
      }
      if (silent.isSilentTailScenario(turnText)) {
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'silent-open', text: silent.SILENT_TAIL_OPENING } } });
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'silent-gh', command: ['bash', '-lc', 'gh issue create'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'reasoning', id: 'silent-rsn', summary: silent.SILENT_TAIL_REASONING, content: silent.SILENT_TAIL_REASONING } } });
        emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
        return;
      }
      if (silent.isToolTailScenario(turnText)) {
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'tool-tail-open', text: silent.TOOL_TAIL_OPENING } } });
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'tool-tail-git', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
        emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
        return;
      }
    }
    // Native thread attribution from collab-agent-tool-call.ndjson (#121/#401).
    if (turnText.includes('mock:subagent-after-park')) {
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', item: { type: 'collabAgentToolCall', id: 'park-spawn', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: ['th_park_child'] } } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', item: { type: 'agentMessage', id: 'park-parent', text: 'Watching the child.\nCEZ:MONITORING' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      await afterParityPark(turnText);
      emit({ method: 'item/started', params: { threadId: 'th_park_child', item: { type: 'commandExecution', id: 'late-read', command: 'cat README.md', status: 'inProgress' } } });
      emit({ method: 'item/completed', params: { threadId: 'th_park_child', item: { type: 'commandExecution', id: 'late-read', command: 'cat README.md', status: 'completed', exitCode: 0 } } });
      emit({ method: 'item/completed', params: { threadId: 'th_park_child', item: { type: 'agentMessage', id: 'late-child', text: 'Post-park child update processed.' } } });
      return;
    }
    // #401: agentMessage completion without deltas (same item envelope as baseline).
    if (turnText.includes('mock:multi-pr-refs')) {
      const { multiPrText, unrelatedPr } = await import('./mock-multi-pr.mjs');
      const text = multiPrText(turnText);
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', item: { type: 'reasoning', id: 'multi-thinking', summary: [unrelatedPr] } } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', item: { type: 'commandExecution', id: 'multi-tool', command: 'cat other.txt', aggregatedOutput: unrelatedPr, status: 'completed', exitCode: 0 } } });
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', item: { type: 'collabAgentToolCall', id: 'multi-spawn', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: ['th_foreign_child'] } } });
      emit({ method: 'item/completed', params: { threadId: 'th_foreign_child', item: { type: 'agentMessage', id: 'multi-child', text: unrelatedPr } } });
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'multi-message', text: '' } } });
      for (const delta of [text.slice(0, 5), text.slice(5)]) emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'multi-message', delta } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'multi-message', text } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:turn-messages:')) {
      const { turnMessages } = await import('./mock-turn-messages.mjs');
      for (const text of turnMessages(turnText)) emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: `item_multi_${++echoSerial}`, text } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:ask-snapshot')) {
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'ask-snapshot', text: turnText.includes('mock:ask-snapshot-bad') ? 'CEZ:ASK {not valid json' : 'Using the CEZ:ASK structured question format instead:\n\nCEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]}]}' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:ask-prose')) {
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'ask-prose', text: 'Use `CEZ:ASK {"questions":[]}` in your reply.\n> CEZ:ASK {not valid json' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:ci-wait')) {
      const { ciPrompt } = await import('./mock-ci-tool.mjs');
      const text = await ciPrompt('codex', ciWire, turnText);
      emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'ci-result', text } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    const steerScenario = ['mock:steer-tool', 'mock:steer-late', 'mock:steer-race', 'mock:steer-strand'].find((marker) => turnText.includes(marker));
    if (steerScenario) {
      const turnId = 'turn_mock_1';
      steerTurn = { id: turnId, steered: [], race: steerScenario === 'mock:steer-race', strand: steerScenario === 'mock:steer-strand' };
      const agent = (text) => emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { type: 'agentMessage', id: `item_steer_${++steerSerial}`, text } } });
      if (steerScenario === 'mock:steer-late') {
        agent(`late window: final message already sent${turnText.includes('mock:done-late') ? '\n\nCEZ:DONE' : ''}`);
        await sleep(300);
        completeSteerTurn(turnId); // steers accepted in this window are never read
        return;
      }
      const exec = { type: 'commandExecution', id: 'exec_steer', command: 'wait', status: 'inProgress' };
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item: exec } });
      await sleep(Number(process.env.CEZ_MOCK_STEER_MS ?? 600));
      if (!steerTurn) return; // a race already ended it
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item: { ...exec, status: 'completed' } } });
      const steered = steerTurn.steered;
      for (const entry of steered) {
        const item = { type: 'userMessage', id: `item_user_${++steerSerial}`, clientId: entry.clientId, content: [{ type: 'text', text: entry.text }] };
        emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId, item } });
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId, item } });
      }
      agent(['steer tool done', ...steered.map((entry) => `saw: ${entry.text}`)].join('\n'));
      completeSteerTurn(turnId);
      return;
    }
    if (turnText.includes('mock:agent-echo')) {
      // Same documented agentMessage/turn completion frames as the baseline below.
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: `item_echo_${++echoSerial}`, text: turnText } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:split-text')) {
      // Deltas that split the marker itself, then the authoritative snapshot on
      // `item/completed` — codex's real streaming shape. A runner emitting one
      // v1 `text` per delta tears `CEZ:MONITORING` into `CEZ:` + `MONITORING`,
      // which is #2 on codex's wire (harness parity S8).
      const full = 'parity split text\n\nCEZ:MONITORING';
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_sp1', text: '' } } });
      for (const delta of ['parity split text\n\n', 'CEZ:', 'MONITORING']) {
        emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_sp1', delta } });
      }
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_sp1', text: full } } });
      emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:ask-bad')) {
      // `questions` is not an array of question objects, so `codexAskQuestions`
      // must reject it: no card renders, and the turn still ends once the
      // rejection lands above (harness parity R4).
      emit({ id: 'ask-bad-1', method: 'item/tool/requestUserInput', params: {
        threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_ask_bad', autoResolutionMs: null,
        questions: 'not-an-array',
      } });
      return;
    }
    if (turnText.includes('mock:hold-done')) {
      await waitForMockRelease(400);
      const full = 'parity hold-done: content after the pause\n\nCEZ:DONE';
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_hd1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_hd1', delta: full } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_hd1', text: full } } });
      emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:hold-ask')) {
      await waitForMockRelease(400);
      const ask = 'Pick one.\n\nCEZ:ASK {"questions":[{"header":"Library","question":"Which test library?","options":[{"label":"Vitest"},{"label":"Node test"}]}]}';
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_ha1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_ha1', delta: ask } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_ha1', text: ask } } });
      emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:done')) {
      // A turn that DECLARES the task complete, so the run reaches cezar's
      // review gate instead of parking for the user. A markerless turn-end
      // correctly parks as `waiting`, which is why harness parity R1 needs
      // this scenario rather than the baseline one.
      const full = 'parity done: the task is complete\n\nCEZ:DONE';
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_d1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_d1', delta: full } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_d1', text: full } } });
      emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (watchdogStall(turnText)) return;
    if (turnText.includes('mock:busy-progress')) {
      for (let i = 0; i < 24; i++) {
        emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'busy', delta: 'working\n' } });
        await new Promise(r => setTimeout(r, 100));
      }
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:hold-gated')) {
      await waitForMockRelease(250);
      const gated = 'parity hold-gated: content after the pause';
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_hg1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_hg1', delta: gated } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_hg1', text: gated } } });
      emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:hold')) {
      // The `turn/start` response and `turn/started` above are the ack. Holding
      // the content AND `turn/completed` behind it is what makes harness parity
      // S2 meaningful: a runner deriving turn-end from the ack reports it before
      // this content ever arrives (the #4 failure mode on codex's wire).
      setTimeout(() => {
        const held = 'parity hold: content after the pause';
        emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_h1', text: '' } } });
        emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_h1', delta: held } });
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_h1', text: held } } });
        emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 }, last: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } } });
        emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      }, 250);
      return;
    }
    if (turnText.includes('mock:stream-retry')) {
      // Error payloads from the real 0.155.1 reconnect probe; see stream-retry.md.
      const frames = [{"method": "error", "params": {"error": {"message": "Reconnecting... 2/5", "codexErrorInfo": {"responseStreamDisconnected": {"httpStatusCode": null}}, "additionalDetails": "stream disconnected before completion: invalid peer certificate: UnknownIssuer"}, "willRetry": true}}, {"method": "error", "params": {"error": {"message": "Reconnecting... waiting for network", "additionalDetails": "Connection failed: error sending request"}, "willRetry": true}}];
      const send = frame => emit({ ...frame, params: { ...frame.params, threadId: 'th_mock_1', turnId: 'turn_mock_1' } });
      send(frames[0]);
      if (turnText.includes('recover')) {
        await sleep(20);
        emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'recovered_message', text: 'Recovered after reconnect.' } } });
        emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      } else {
        send(frames[1]);
        const retries = setInterval(() => send(frames[1]), 10_000);
        rl.once('close', () => clearInterval(retries));
      }
      return;
    }
    if (turnText.includes('mock:provider-error') || turnText.includes('mock:empty-success')) {
      // Derived from the 0.147 rollout and upstream envelope; see the source
      // core/__fixtures__/codex/provider-error.md and its independent golden NDJSON.
      const completion = {"method": "turn/completed", "params": {"threadId": "th_mock_1", "turn": {"id": "turn_mock_1", "items": [], "itemsView": "notLoaded", "status": "failed", "error": {"message": "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.\"}}", "codexErrorInfo": "other", "additionalDetails": null}, "startedAt": 1788632328, "completedAt": 1788632331, "durationMs": 3502}}};
      if (turnText.includes('mock:empty-success')) {
        completion.params.turn.status = 'completed';
        completion.params.turn.error = null;
      }
      emit(completion);
      return;
    }
    if (turnText.includes('mock:turn-failed')) {
      emit({ method: 'turn/failed', params: {
        turn: { id: 'turn_mock_1', status: 'failed' },
        error: { message: turnText.includes('mock:legacy-interrupt') ? 'Turn interrupted by user' : 'model unavailable' },
      } });
      return;
    }
    if (turnText.includes('mock:subagent-activity')) {
      emit({ method: 'item/started', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/completed', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/started', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'inProgress', receiverThreadIds: [] } } });
      emit({ method: 'item/completed', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'completed', receiverThreadIds: [] } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:child-turn')) {
      // A spawned sub-agent runs in its OWN child thread that emits a full turn
      // lifecycle over the shared connection. Its turn/completed must not end the
      // parent turn (#600): the parent is still working after the child finishes.
      // Collaboration attribution from collab-agent-tool-call.ndjson; late text reproduces #149.
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', item: { type: 'collabAgentToolCall', id: 'item_spawn', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: ['th_child'] } } });
      emit({ method: 'turn/started', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'inProgress', items: [] } } });
      emit({ method: 'item/started', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'commandExecution', id: 'item_child', command: ['rg', 'requestUserInput'], cwd: '/repo', status: 'inProgress' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'completed' } } });
      // Parent keeps streaming after the child's turn ended.
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_p1', delta: 'Still working after the sub-agent.\nCEZ:MONITORING' } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: 'Still working after the sub-agent.\nCEZ:MONITORING' } } });
      emit({ method: 'item/completed', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'agentMessage', id: 'item_child_text', text: 'Child review finished.' } } });
      // No completion for this second child item: parent turn-end must not flush it into v1.
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_child', turnId: 'turn_child', itemId: 'item_child_partial', delta: 'Child review still streaming.' } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (process.env.MOCK_CODEX_ASK === '1' || turnText.includes('mock:native-codex-ask')) {
      resumeAfterAsk = turnText.includes('mock:resume-done');
      const questions = turnText.includes('multi free text')
        ? [{ id: 'first', header: 'First', question: 'First choice?', isOther: true, isSecret: false,
            options: [{ label: 'A', description: 'Option A.' }, { label: 'B', description: 'Option B.' }] },
          { id: 'second', header: 'Second', question: 'Second choice?', isOther: true, isSecret: false,
            options: [{ label: 'C', description: 'Option C.' }, { label: 'D', description: 'Option D.' }] }]
        : [{ id: 'library', header: 'Library', question: 'Which test library?', isOther: true,
            isSecret: false, options: [{ label: 'Vitest', description: 'Use the existing test runner.' },
              { label: 'Node test', description: 'Use node:test.' }] }];
      emit({ id: 'ask-1', method: 'item/tool/requestUserInput', params: {
        threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_ask_1', autoResolutionMs: null,
        questions,
      } });
      return;
    }
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: '' } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_m1', delta: 'Checking the working tree.' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: 'Checking the working tree.' } } });
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'inProgress' } } });
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_c1', delta: ' M src/example.ts\n' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m2', text: '' } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_m2', delta: 'Done with the first pass.' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m2', text: 'Done with the first pass.' } } });
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 }, last: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } } } });
    emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  }
});

rl.on('close', () => {
  if (!ignoreEof) process.exit(0);
});
