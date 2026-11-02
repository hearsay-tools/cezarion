// `mock:subagent-background` on the Codex app-server wire (hearsay-tools/cezarion#2431). Frame
// shapes follow src/core/__fixtures__/codex/background-subagent.ndjson, trimmed from a live
// codex-cli 0.164.0 capture: the parent turn completes while the spawned child thread runs; the
// child's end is its own turn/completed (rootTurnId = the parent turn) and then a parent-thread
// `subAgentActivity(kind: completed)` stamped with the already-completed parent turn id. Codex
// never starts a parent turn by itself, so there is no `subagent-resume`, and it reports no
// failed or interrupted child, so `subagent-status` is ignored. Prompt tokens:
// - `parity-release=<path>` (required): the children's end waits until this file exists;
// - `subagents=<n>`: spawn n children, th_bg_01…, whose ends follow in order;
// - `subagent-duplicate`: send each completed activity twice;
// - `mock:monitoring` / `mock:done`: the parking turn's text ends with that marker.
// The parking turn returns at once, so turns started while the children run are answered.
export async function replyWithBackgroundSubagents(turnText, { emit, afterParityPark }) {
  const count = Math.max(1, Number(/\bsubagents=(\d+)/.exec(turnText)?.[1] ?? 1));
  const parentTurn = 'turn_mock_1';
  const children = Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');
    return { callId: `call_bg_${n}`, threadId: `th_bg_${n}`, turnId: `turn_bg_${n}`, agentPath: `/root/background_${n}` };
  });
  const onParent = (item) => ({ threadId: 'th_mock_1', turnId: parentTurn, item });
  for (const child of children) {
    const started = { type: 'subAgentActivity', model: 'gpt-mock', reasoningEffort: 'low', id: child.callId, kind: 'started', agentThreadId: child.threadId, agentPath: child.agentPath };
    emit({ method: 'thread/status/changed', params: { threadId: child.threadId, status: { type: 'idle' } } });
    emit({ method: 'item/started', params: onParent(started) });
    emit({ method: 'item/completed', params: onParent(started) });
    emit({ method: 'thread/status/changed', params: { threadId: child.threadId, status: { type: 'active', activeFlags: [] } } });
    emit({ method: 'turn/started', params: { threadId: child.threadId, turn: { id: child.turnId, rootTurnId: parentTurn, items: [], status: 'inProgress' } } });
  }
  const marker = turnText.includes('mock:monitoring') ? '\nCEZ:MONITORING' : turnText.includes('mock:done') ? '\nCEZ:DONE' : '';
  const parked = `SPAWNED ${count}${marker}`;
  emit({ method: 'item/completed', params: onParent({ type: 'agentMessage', id: 'bg-parent', text: parked, phase: 'final_answer' }) });
  emit({ method: 'thread/status/changed', params: { threadId: 'th_mock_1', status: { type: 'idle' } } });
  emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: parentTurn, rootTurnId: parentTurn, status: 'completed' } } });
  void (async () => {
    await afterParityPark(turnText);
    for (const child of children) {
      const command = { type: 'commandExecution', id: `exec_${child.callId}`, command: 'sleep 1', cwd: '/repo' };
      emit({ method: 'item/started', params: { threadId: child.threadId, turnId: child.turnId, item: { ...command, status: 'inProgress' } } });
      emit({ method: 'item/completed', params: { threadId: child.threadId, turnId: child.turnId, item: { ...command, status: 'completed', exitCode: 0 } } });
      emit({ method: 'thread/status/changed', params: { threadId: child.threadId, status: { type: 'idle' } } });
      emit({ method: 'turn/completed', params: { threadId: child.threadId, turn: { id: child.turnId, rootTurnId: parentTurn, status: 'completed' } } });
      const ended = { type: 'subAgentActivity', model: null, reasoningEffort: null, id: `subagent-completed-${child.turnId}`, kind: 'completed', agentThreadId: child.threadId, agentPath: child.agentPath };
      for (let copy = turnText.includes('subagent-duplicate') ? 2 : 1; copy > 0; copy -= 1) {
        emit({ method: 'item/started', params: onParent(ended) });
        emit({ method: 'item/completed', params: onParent(ended) });
      }
    }
  })().catch((error) => {
    process.stderr.write(`mock-codex-subagents: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
