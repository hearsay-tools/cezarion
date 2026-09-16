import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCursorUiState, cursorTurnStarted, cursorTurnCompleted, mapCursorMessage } from './cursor-ui-mapper.js';
import type { UiEvent } from './ui-events.js';

const update = (value: Record<string, unknown>) => ({ method: 'session/update', params: { sessionId: 's', update: value } });
const text = (value: string, thought = false) => update({ sessionUpdate: thought ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text: value } });
const start = () => cursorTurnStarted({ ...createCursorUiState(), sessionId: 's' }).state;

describe('Cursor ACP mapper', () => {
  it('assembles split text immutably and flushes on tools and completion', () => {
    const initial = start();
    const first = mapCursorMessage(text('hel'), initial);
    const second = mapCursorMessage(text('lo'), first.state);
    expect(first.events).toEqual([{ type: 'item.started', item: { kind: 'message', id: 'cursor_text_1', role: 'assistant', text: 'hel' } }]);
    expect(second.events).toEqual([{ type: 'item.delta', itemId: 'cursor_text_1', field: 'text', delta: 'lo' }]);
    expect(first.state.activeText?.text).toBe('hel');
    expect(initial.activeText).toBeUndefined();
    const tool = mapCursorMessage(update({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read file', kind: 'read', status: 'pending' }), second.state);
    expect(tool.events[0]).toMatchObject({ type: 'item.completed', item: { text: 'hello' } });
    expect(second.state.tools.size).toBe(0);
    const thought = mapCursorMessage(text('thinking', true), tool.state);
    const done = cursorTurnCompleted('cancelled', thought.state);
    expect(done.events).toEqual([{ type: 'item.completed', item: { id: 'cursor_text_2', kind: 'reasoning', text: 'thinking' } }, { type: 'turn.completed', turnId: 'turn_1', stopReason: 'cancelled' }]);
    expect(cursorTurnCompleted('end_turn', done.state).events).toEqual([]);
    expect(cursorTurnStarted(done.state).events).toEqual([{ type: 'turn.started', turnId: 'turn_2' }]);
  });

  it('merges tool patches without mutating prior maps or snapshots', () => {
    const a = mapCursorMessage(update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit file', kind: 'edit', status: 'pending', rawInput: { path: '/tmp/a' } }), start());
    const b = mapCursorMessage(update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'in_progress', locations: [{ path: '/tmp/a', line: 2 }] }), a.state);
    const c = mapCursorMessage(update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'permission denied' } }, { type: 'diff', path: '/tmp/a', oldText: 'old', newText: 'new' }] }), b.state);
    expect(c.events).toEqual([{ type: 'item.completed', item: { kind: 'tool', id: 'edit', name: 'edit', title: 'Edit file', toolKind: 'edit', status: 'failed', input: { path: '/tmp/a' }, output: 'permission denied', error: 'permission denied', locations: [{ path: '/tmp/a', line: 2 }], diffs: [{ path: '/tmp/a', oldText: 'old', newText: 'new' }] } }]);
    expect(a.state.tools.get('edit')?.status).toBe('pending');
    expect(b.state.tools.get('edit')?.status).toBe('running');
    expect(c.state.tools).not.toBe(b.state.tools);
  });

  it('maps new-file diffs with omitted oldText and replaces content snapshots', () => {
    const first = mapCursorMessage(update({ sessionUpdate: 'tool_call', toolCallId: 'new', kind: 'edit', title: 'Write file', status: 'in_progress', content: [
      { type: 'diff', path: '/tmp/new', newText: 'new file' },
      { type: 'content', content: { type: 'text', text: 'working' } },
    ] }), start());
    expect(first.state.tools.get('new')?.diffs).toEqual([{ path: '/tmp/new', oldText: null, newText: 'new file' }]);
    const next = mapCursorMessage(update({ sessionUpdate: 'tool_call_update', toolCallId: 'new', status: 'completed', content: [] }), first.state);
    expect(next.state.tools.get('new')?.output).toBeUndefined();
    expect(next.state.tools.get('new')?.diffs).toEqual([]);
    expect(first.state.tools.get('new')?.output).toBe('working');
  });

  it('renders rawOutput and tolerates missing tool start', () => {
    const mapped = mapCursorMessage(update({ sessionUpdate: 'tool_call_update', toolCallId: 'late', status: 'completed', rawOutput: { ok: true } }), start());
    expect(mapped.events).toMatchObject([{ type: 'item.started', item: { id: 'late' } }, { type: 'item.completed', item: { output: '{"ok":true}', status: 'completed' } }]);
  });

  it('merges Cursor todos by id and preserves task failure without inventing child work', () => {
    const todos = (todos: unknown[], merge: boolean) => ({ method: 'cursor/update_todos', params: { toolCallId: 'todos', todos, merge } });
    const a = mapCursorMessage(todos([{ id: 'a', content: 'A', status: 'pending' }, { id: 'b', content: 'B', status: 'completed' }], false), start());
    const b = mapCursorMessage(todos([{ id: 'a', content: 'A', status: 'in_progress' }], true), a.state);
    expect(b.events).toEqual([{ type: 'plan.updated', entries: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'completed' }] }]);
    expect(a.state.todos.get('a')?.status).toBe('pending');
    const failed = mapCursorMessage(update({ sessionUpdate: 'tool_call', toolCallId: 'task', kind: 'other', title: 'Explore', status: 'failed' }), b.state);
    const task = mapCursorMessage({ method: 'cursor/task', params: { toolCallId: 'task', description: 'Explore', prompt: 'Find files', subagentType: 'explore' } }, failed.state);
    expect(task.events).toMatchObject([{ type: 'item.updated', item: { toolKind: 'task', status: 'failed' } }]);
    expect(task.state.tools.get('task')).not.toHaveProperty('parentItemId');
    expect(mapCursorMessage(todos([], false), b.state).events).toEqual([{ type: 'plan.updated', entries: [] }]);
  });

  it('maps optional ACP context telemetry separately from baseline Cursor fixtures', () => {
    const mapped = mapCursorMessage(update({ sessionUpdate: 'usage_update', used: 20, size: 100, cost: { amount: 0.5, currency: 'USD' } }), start());
    expect(mapped.events).toEqual([{ type: 'usage.updated', usage: { input: 0, output: 0, total: 20, contextWindow: 100 }, costUsd: 0.5 }]);
    expect(cursorTurnCompleted('end_turn', mapped.state).events).toEqual([{ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' }]);
    expect(mapCursorMessage(update({ sessionUpdate: 'usage_update', used: -1, size: 100 }), mapped.state).events).toEqual([]);
  });

  it.each([null, [], 1, {}, { method: 'unknown' }, update({ sessionUpdate: 'tool_call', toolCallId: '' }), update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 3 } }), update({ sessionUpdate: 'plan', entries: null }), update({ sessionUpdate: 'usage_update', used: NaN, size: 100 })])('ignores malformed frames without mutating state: %j', (frame) => {
    const state = start();
    const mapped = mapCursorMessage(frame, state);
    expect(mapped).toEqual({ state, events: [] });
    expect(mapped.state).toBe(state);
  });

  it('ignores hostile JSON enum values without invoking object coercion', () => {
    const mapped = mapCursorMessage(update({ sessionUpdate: 'plan', entries: [
      { content: 'Bad status', status: { toString: 3 } },
      { content: 'Good entry', status: 'pending', priority: { toString: 3 } },
    ] }), start());
    expect(mapped.events).toEqual([{ type: 'plan.updated', entries: [{ content: 'Good entry', status: 'pending' }] }]);
  });

  it.each([['end_turn', 'end_turn'], ['max_tokens', 'max_tokens'], ['max_turn_requests', 'max_tokens'], ['refusal', 'refusal'], ['cancelled', 'cancelled'], ['error', 'error'], ['unknown', 'error']])('normalizes stop reason %s', (wire, expected) => {
    expect(cursorTurnCompleted(wire, start()).events.at(-1)).toMatchObject({ stopReason: expected });
  });
});

describe('Cursor ACP golden fixtures', () => {
  it('replays schema/source-derived lifecycle frames exactly as the runner drives the mapper', () => {
    const base = new URL('./__fixtures__/cursor/', import.meta.url);
    const frames = readFileSync(new URL('acp-lifecycle.ndjson', base), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    let state = createCursorUiState();
    const events: UiEvent[] = [];
    const push = (mapped: ReturnType<typeof mapCursorMessage>) => { state = mapped.state; events.push(...mapped.events); };
    state = { ...state, sessionId: 's' };
    push(cursorTurnStarted(state));
    for (const frame of frames) {
      if (frame.result?.stopReason) push(cursorTurnCompleted(frame.result.stopReason, state));
      else push(mapCursorMessage(frame, state));
    }
    expect(events).toStrictEqual(JSON.parse(readFileSync(new URL('acp-lifecycle.expected.json', base), 'utf8')));
  });
});
