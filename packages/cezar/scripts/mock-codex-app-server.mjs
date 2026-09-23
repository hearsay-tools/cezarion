#!/usr/bin/env node
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

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
// #505: like the real app-server, any active main-thread turn accepts `turn/steer`.
// Steers accepted by an ordinary scripted turn are read just before it completes:
// a userMessage item (echoing clientUserMessageId as clientId) and an echo reply.
let activeTurnId = null;
let pendingSteers = [];
let steerEchoSerial = 0;
const emit = (obj) => {
  const ending = (obj.method === 'turn/completed' || obj.method === 'turn/failed') && (!obj.params?.threadId || obj.params.threadId === 'th_mock_1');
  if (ending && obj.method === 'turn/completed' && pendingSteers.length) {
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
};
const rl = createInterface({ input: process.stdin });
let echoSerial = 0;
let ciWire;
// #505 steering scenarios: the one turn that accepts `turn/steer`, while it is open.
let steerTurn = null;
let steerSerial = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const completeSteerTurn = (turnId) => {
  steerTurn = null;
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: turnId, status: 'completed' } } });
};

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
    emit((Array.isArray(answer) && answer[0] === 'Vitest') || (Array.isArray(freeText) && freeText[0] === 'Use sensible defaults')
      ? { method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } }
      : { method: 'turn/failed', params: { turn: { id: 'turn_mock_1', status: 'failed' }, error: { message: 'bad answer' } } });
  } else if (msg.method === 'turn/steer') {
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
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    if (process.env.CEZ_MOCK_CI_PR) { const { probeCiTool } = await import('./mock-ci-tool.mjs'); await probeCiTool('codex', msg.params); }
    ciWire = msg.params;
    const expectedSandbox = process.env.CEZ_CODEX_NETWORK === '0' ? 'workspace-write' : 'danger-full-access';
    if (msg.params?.sandbox !== expectedSandbox || msg.params?.approvalPolicy !== undefined) {
      emit({ id: msg.id, error: { code: -32602, message: `expected ${expectedSandbox} managed permissions` } });
      return;
    }
    if (process.argv.includes('sandbox_workspace_write.network_access=true')) {
      emit({ id: msg.id, error: { code: -32602, message: 'workspace-write override is obsolete in full-access mode' } });
      return;
    }
    if (msg.method === 'thread/start') {
      emit({ method: 'thread/started', params: { thread: { id: 'th_mock_1' } } });
      emit({ id: msg.id, result: { thread: { id: 'th_mock_1' } } });
    } else if (process.env.MOCK_CODEX_REJECT_RESUME === '1') {
      emit({ id: msg.id, error: { code: -32603, message: `no rollout found for thread id ${msg.params?.threadId ?? ''}` } });
      rl.close();
    } else {
      emit({ id: msg.id, result: { thread: { id: msg.params?.threadId } } });
    }
  } else if (msg.method === 'turn/start') {
    activeTurnId = 'turn_mock_1';
    emit({ id: msg.id, result: { turn: { id: 'turn_mock_1' } } });
    emit({ method: 'turn/started', params: { turn: { id: 'turn_mock_1', status: 'inProgress', items: [] } } });
    const turnText = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
    // The real app-server records the turn's own input as a userMessage item,
    // echoing clientUserMessageId as clientId (probe 0.155.1, #505).
    const opening = { type: 'userMessage', id: `item_user_open_${++steerEchoSerial}`, clientId: msg.params?.clientUserMessageId ?? null, content: [{ type: 'text', text: turnText }] };
    if (process.env.CEZ_MOCK_CODEX_NO_USER_ITEM !== '1') {
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: opening } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: opening } });
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
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 }, last: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } } } });
    emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  }
});

rl.on('close', () => {
  if (!ignoreEof) process.exit(0);
});
