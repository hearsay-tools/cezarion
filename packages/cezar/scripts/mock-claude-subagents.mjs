// `mock:subagent-background` (hearsay-tools/cezarion#2431, hearsay-tools/cezarion#1512): a
// backgrounded native Agent that outlives the parent's turn. Frame shapes follow
// src/core/__fixtures__/claude/background-agent.ndjson, reconstructed from a live CLI 2.1.303
// transcript. Prompt tokens:
// - `parity-release=<path>` (required): the child's end waits until this file exists;
// - `subagents=<n>`: spawn n children, abg01…abg0n, whose notifications follow in order;
// - `subagent-status=completed|failed|stopped`: each notification's status (default completed);
// - `subagent-duplicate`: send each notification twice;
// - `subagent-resume`: after the notifications, run an unprompted parent turn (system/init,
//   parent text, result) with no stdin line; `subagent-resume-done` ends that turn with CEZ:DONE.
// - `mock:monitoring` / `mock:done`: the parking turn's text ends with that marker.
// The parking turn returns at once, so stdin lines written while the children run are answered.
export async function replyWithBackgroundSubagents(userText, { emit, afterParityPark }) {
  const count = Math.max(1, Number(/\bsubagents=(\d+)/.exec(userText)?.[1] ?? 1));
  const status = /\bsubagent-status=(completed|failed|stopped)\b/.exec(userText)?.[1] ?? 'completed';
  const children = Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');
    return { toolUseId: `toolu_bg_${n}`, taskId: `abg${n}` };
  });
  const parent = { parent_tool_use_id: null };
  for (const { toolUseId, taskId } of children) {
    const description = `Background research ${taskId}`;
    emit({ type: 'assistant', ...parent, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent',
      input: { description, prompt: 'Trace the park path and report.', subagent_type: 'general-purpose', run_in_background: true } }] } });
    emit({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description,
      subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent' });
    emit({ type: 'user', ...parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text',
      text: `Async agent launched successfully.\nagentId: ${taskId}\nThe agent is working in the background. You will be notified automatically when it completes.` }] }] },
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: taskId, description, outputFile: `/tmp/tasks/${taskId}.output`, canReadOutputFile: true } });
  }
  const marker = userText.includes('mock:monitoring') ? '\n\nCEZ:MONITORING' : userText.includes('mock:done') ? '\n\nCEZ:DONE' : '';
  const parked = `Started ${count === 1 ? 'a background agent' : `${count} background agents`}; I will continue when ${count === 1 ? 'it reports' : 'they report'}.${marker}`;
  emit({ type: 'assistant', ...parent, message: { role: 'assistant', content: [{ type: 'text', text: parked }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: parked, usage: { input_tokens: 10, output_tokens: 5 } });
  void (async () => {
    await afterParityPark(userText);
    for (const { toolUseId, taskId } of children) {
      emit({ type: 'assistant', parent_tool_use_id: toolUseId, agent_id: taskId,
        message: { role: 'assistant', content: [{ type: 'text', text: `Background child ${taskId} is working.` }] } });
      const notification = { type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId, status,
        output_file: `/tmp/tasks/${taskId}.output`, summary: `Agent "Background research ${taskId}" ${status === 'completed' ? 'finished' : status}` };
      emit(notification);
      if (userText.includes('subagent-duplicate')) emit(notification);
    }
    if (!userText.includes('subagent-resume')) return;
    const resumed = `The background ${count === 1 ? 'agent' : 'agents'} reported ${status}.${userText.includes('subagent-resume-done') ? '\n\nCEZ:DONE' : ''}`;
    emit({ type: 'system', subtype: 'init' });
    emit({ type: 'assistant', ...parent, message: { role: 'assistant', content: [{ type: 'text', text: resumed }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: resumed, usage: { input_tokens: 10, output_tokens: 5 } });
  })().catch((error) => {
    process.stderr.write(`mock-claude-subagents: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
