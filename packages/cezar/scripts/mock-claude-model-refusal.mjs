// Native Claude stream-json fixtures, with independent per-input retry counts.
const attempts = new Map();
const model = 'claude-test-model';
export async function modelRefusalReply(text, uuid, emit, replay) {
  const mode = text.split(':')[2];
  const count = (attempts.get(text) ?? 0) + 1;
  attempts.set(text, count);
  const selected = mode === 'changed' ? 'claude-other-model' : model;
  emit({ type: 'system', subtype: 'init', ...(mode === 'missing-session' ? {} : { session_id: mode === 'changed-session' ? 'other-session' : mode === 'empty-session' ? '' : 'model-refusal-session' }),
    ...(mode === 'missing-model' ? {} : { model: mode === 'empty-model' ? '' : selected }) });
  if (mode === 'seed' || mode === 'queued-seed' || (mode === 'once' && count > 1) || mode === 'later') {
    replay(uuid, text);
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Completed ${text}` }] } });
    // Leave the final model call complete while another stdin line queues.
    if (mode === 'queued-seed') await new Promise(resolve => setTimeout(resolve, 250));
    emit({ type: 'result', subtype: 'success', result: `Completed ${text}`,
      usage: { input_tokens: 10, output_tokens: 5 }, user_message_uuids: [uuid], queued_turn_count: 0 });
    return;
  }
  const refused = mode === 'wrong-model' ? 'claude-wrong-model' : selected;
  let message = `There's an issue with the selected model (${refused}). It may not exist or you may not have access to it. Run --model to pick a different model.`;
  if (mode === 'auth') message = 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';
  if (mode === 'limit') message = 'API Error: Request rejected (429) · All credentials are cooling down. Please try again later.';
  if (mode.startsWith('system-')) emit({ type: 'system', subtype: mode.slice(7).replaceAll('-', '_'), task_id: 'already-started' });
  if (mode === 'tool-progress') emit({ type: 'tool_progress', tool_use_id: 'already-started', tool_name: 'Bash', elapsed_time_seconds: 1 });
  if (mode === 'work') emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'already-ran', name: 'Bash', input: { command: 'touch result' } }] } });
  if (mode === 'prose') emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I already changed the file.' }] } });
  if (mode === 'assistant-usage') emit({ type: 'assistant', message: { role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
  // Both real diagnostic sources: the visible assistant frame and is_error result.
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: message }] } });
  const usage = { input_tokens: mode === 'used' ? 1 : 0, output_tokens: 0,
    service_tier: 'standard', cache_read_input_tokens: mode === 'cached' ? 1 : 0 };
  if (mode === 'missing-count') delete usage.output_tokens;
  if (mode === 'invalid-count') usage.input_tokens = -1;
  emit({ type: 'result', subtype: 'success', is_error: true, result: message,
    modelUsage: { [selected]: { inputTokens: mode === 'model-tokens' ? 1 : 0,
      outputTokens: 0, costUSD: mode === 'model-cost' ? 0.01 : mode === 'model-invalid' ? null : 0,
      contextWindow: 200000, maxOutputTokens: 64000 } },
    ...(mode === 'missing-usage' ? {} : { usage }),
    ...(mode === 'paid' ? { total_cost_usd: 0.01 } : { total_cost_usd: 0 }),
    user_message_uuids: [uuid], queued_turn_count: 0 });
}
