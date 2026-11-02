/**
 * Backgrounded native subagents on the Claude wire (hearsay-tools/cezarion#2431): the root task
 * item carries `background: true`, stays running after its spawn acknowledgement and completes
 * exactly once, from `system/task_notification`. The golden `background-agent` fixture pins the
 * whole sequence; these cases pin each branch.
 */
import { describe, expect, it } from 'vitest';

import type { UiEvent, UiToolItem } from './ui-events.ts';
import { createClaudeUiState, mapClaudeMessage, type ClaudeUiMapperState } from './claude-ui-mapper.ts';

function fold(frames: readonly unknown[], start: ClaudeUiMapperState = createClaudeUiState()): { events: UiEvent[]; state: ClaudeUiMapperState } {
  let state = start;
  const events: UiEvent[] = [];
  for (const frame of frames) {
    const mapped = mapClaudeMessage(frame, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return { events, state };
}

const toolItems = (events: readonly UiEvent[]): Array<{ type: string; item: UiToolItem }> =>
  events.flatMap(event => 'item' in event && event.item.kind === 'tool' ? [{ type: event.type, item: event.item }] : []);

const spawn = (id = 'toolu_a', parent?: string) => ({
  type: 'assistant', parent_tool_use_id: parent ?? null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Research', prompt: 'Look', run_in_background: true } }] },
});
const started = (backgrounded: boolean, id = 'toolu_a', taskId = 'agent-a') => ({
  type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: id, description: 'Research', is_backgrounded: backgrounded, task_type: 'local_agent',
});
const ack = (id = 'toolu_a', agentId: string | undefined = 'agent-a', extra: Record<string, unknown> = {}) => ({
  type: 'user', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'Async agent launched successfully.' }], ...extra }] },
  tool_use_result: { isAsync: true, status: 'async_launched', ...(agentId ? { agentId } : {}) },
});
const notification = (status: string, fields: Record<string, unknown> = { task_id: 'agent-a', tool_use_id: 'toolu_a' }) => ({
  type: 'system', subtype: 'task_notification', status, summary: 'Agent "Research" stopped', ...fields,
});
const turnEnd = { type: 'result', subtype: 'success', is_error: false, result: 'Waiting.', usage: { input_tokens: 1, output_tokens: 1 } };

describe('claude background subagents (hearsay-tools/cezarion#2431)', () => {
  it('marks the root task item on task_started and keeps it running through the acknowledgement and the turn end', () => {
    const { events } = fold([spawn(), started(true), ack(), turnEnd]);
    expect(toolItems(events).map(({ type, item }) => [type, item.status, item.background])).toEqual([
      ['item.started', 'running', undefined],
      ['item.updated', 'running', true],
      ['item.updated', 'running', true],
    ]);
    expect(toolItems(events).at(-1)!.item.output).toBe('Async agent launched successfully.');
  });

  it('marks the item from the async_launched acknowledgement alone', () => {
    const { events, state } = fold([spawn(), ack()]);
    expect(toolItems(events).map(({ type, item }) => [type, item.status, item.background]).at(-1)).toEqual(['item.updated', 'running', true]);
    expect(state.backgroundTasks.has('toolu_a')).toBe(true);
  });

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['stopped', 'declined'],
    ['killed', 'declined'],
  ])('maps a %s notification to one %s item.completed', (wire, status) => {
    const { events, state } = fold([spawn(), started(true), ack(), turnEnd, notification(wire)]);
    const completed = toolItems(events).filter(({ type }) => type === 'item.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.item).toMatchObject({ id: 'toolu_a', status, background: true });
    expect(completed[0]!.item.error).toBe(status === 'failed' ? 'Agent "Research" stopped' : undefined);
    expect(state.backgroundTasks.size).toBe(0);
  });

  it('finds the child by its task id when the notification has no tool_use_id', () => {
    const { events } = fold([spawn(), ack(), notification('failed', { task_id: 'agent-a' })]);
    expect(toolItems(events).filter(({ type }) => type === 'item.completed').map(({ item }) => [item.id, item.status, item.background]))
      .toEqual([['toolu_a', 'failed', true]]);
  });

  it('emits nothing for a repeated notification or a late result of an ended child', () => {
    const { state } = fold([spawn(), started(true), ack(), notification('completed')]);
    expect(fold([notification('completed'), notification('failed'), ack()], state).events).toEqual([]);
  });

  it('emits nothing for a notification it cannot match', () => {
    const { events } = fold([spawn(), ack(), notification('completed', { task_id: 'other', tool_use_id: 'toolu_other' })]);
    expect(toolItems(events).filter(({ type }) => type === 'item.completed')).toEqual([]);
  });

  it('keeps a foreground fork on the ordinary tool lifecycle', () => {
    const fork = [
      spawn(), started(false), notification('completed'),
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Done.' }] } },
    ];
    const items = toolItems(fold(fork).events);
    expect(items.map(({ type, item }) => [type, item.status, item.background])).toEqual([
      ['item.started', 'running', undefined],
      ['item.completed', 'completed', undefined],
    ]);
  });

  it('leaves a nested background spawn passive', () => {
    const nested = [spawn('toolu_child', 'toolu_root'), started(true, 'toolu_child', 'agent-child'), ack('toolu_child', 'agent-child')];
    const items = toolItems(fold(nested).events);
    expect(items.some(({ item }) => item.background)).toBe(false);
    expect(items.at(-1)).toMatchObject({ type: 'item.completed', item: { id: 'toolu_child', status: 'completed' } });
  });

  it('fails a refused spawn instead of marking it', () => {
    const items = toolItems(fold([spawn(), ack('toolu_a', 'agent-a', { is_error: true })]).events);
    expect(items.map(({ type, item }) => [type, item.status, item.background]).at(-1)).toEqual(['item.completed', 'failed', undefined]);
  });
});
