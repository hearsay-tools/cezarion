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

  it.each([null, {}, [null], [{ content: 'missing status' }], [
    { id: 'new', content: 'Valid', status: 'completed' }, { content: 'Broken', status: false },
  ]].map((entries) => [entries]))('preserves the dock when a plan or todo snapshot is malformed: %j', (entries) => {
    const initial = mapCursorMessage({ method: 'cursor/update_todos', params: { merge: false,
      todos: [{ id: 'existing', content: 'Keep this', status: 'pending' }],
    } }, start()).state;
    for (const frame of [update({ sessionUpdate: 'plan', entries }),
      { method: 'cursor/update_todos', params: { merge: false, todos: entries } },
      { method: 'cursor/update_todos', params: { merge: true, todos: entries } }]) {
      const mapped = mapCursorMessage(frame, initial);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(initial);
      expect([...mapped.state.todos.values()]).toEqual([{ content: 'Keep this', status: 'pending' }]);
    }
  });

  it('rejects a todo without an id but permits deliberate empty snapshots', () => {
    const state = start();
    const invalid = mapCursorMessage({ method: 'cursor/update_todos', params: { merge: false,
      todos: [{ content: 'No id', status: 'pending' }],
    } }, state);
    expect(invalid).toEqual({ state, events: [] });
    expect(mapCursorMessage(update({ sessionUpdate: 'plan', entries: [] }), state).events).toEqual([{ type: 'plan.updated', entries: [] }]);
  });

  it('does not misreport optional ACP context occupancy as cumulative token usage', () => {
    const mapped = mapCursorMessage(update({ sessionUpdate: 'usage_update', used: 20, size: 100, cost: { amount: 0.5, currency: 'USD' } }), start());
    expect(mapped.events).toEqual([]);
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
    expect(mapped.events).toEqual([]);
  });

  it.each([['end_turn', 'end_turn'], ['max_tokens', 'max_tokens'], ['max_turn_requests', 'max_tokens'], ['refusal', 'refusal'], ['cancelled', 'cancelled'], ['error', 'error'], ['unknown', 'error']])('normalizes stop reason %s', (wire, expected) => {
    expect(cursorTurnCompleted(wire, start()).events.at(-1)).toMatchObject({ stopReason: expected });
  });
});

describe('Cursor ACP golden fixtures', () => {
  it.each(['acp-lifecycle', 'acp-subagents'])('replays source/schema-derived %s exactly as the runner drives the mapper', (fixture) => {
    const base = new URL('./__fixtures__/cursor/', import.meta.url);
    const frames = readFileSync(new URL(`${fixture}.ndjson`, base), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    let state = createCursorUiState();
    const events: UiEvent[] = [];
    const push = (mapped: ReturnType<typeof mapCursorMessage>) => { state = mapped.state; events.push(...mapped.events); };
    state = { ...state, sessionId: 's' };
    push(cursorTurnStarted(state));
    for (const frame of frames) {
      if (frame.result?.stopReason) push(cursorTurnCompleted(frame.result.stopReason, state));
      else push(mapCursorMessage(frame, state));
    }
    expect(events).toStrictEqual(JSON.parse(readFileSync(new URL(`${fixture}.expected.json`, base), 'utf8')));
  });
});

describe('Cursor negotiated subagent sessions', () => {
  const scoped = (sessionId: string, value: Record<string, unknown>) => ({ method: 'session/update', params: { sessionId, update: value } });
  const spawn = (sessionId = 's', child = 'child', toolCallId = 'task') => scoped(sessionId, {
    sessionUpdate: 'subagent_spawned', subagentSessionId: child, name: 'Explorer', task: 'Find files', capabilities: {},
    _meta: { cursor: { toolCallId, agentId: child } },
  });
  const chunk = (sessionId: string, value: string) => scoped(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });

  it('isolates interleaved parent and child text and ignores unannounced sessions', () => {
    const parent = mapCursorMessage(text('Parent'), start());
    expect(mapCursorMessage(chunk('unknown', 'wrong'), parent.state)).toEqual({ state: parent.state, events: [] });
    const announced = mapCursorMessage(spawn(), parent.state);
    const child = mapCursorMessage(chunk('child', 'Child'), announced.state);
    expect(child.events).toMatchObject([{ type: 'item.started', item: { text: 'Child', parentItemId: 'task' } }]);
    const childId = child.events[0]?.type === 'item.started' ? child.events[0].item.id : '';
    expect(childId).not.toBe('cursor_text_1');
    const continued = mapCursorMessage(text(' continues'), child.state);
    expect(continued.events).toEqual([{ type: 'item.started', item: { kind: 'message', id: 'cursor_text_2', role: 'assistant', text: ' continues' } }]);
    const more = mapCursorMessage(chunk('child', ' continues'), continued.state);
    expect(more.events).toEqual([{ type: 'item.delta', itemId: childId, field: 'text', delta: ' continues' }]);
    expect(child.state.childSessions.get('child')?.state.activeText?.text).toBe('Child');
    expect(parent.state.childSessions.size).toBe(0);
  });

  it('keeps child extension todos out of the parent plan dock', () => {
    let state = mapCursorMessage(spawn(), cursorTurnStarted({ ...createCursorUiState(), sessionId: 's' }).state).state;
    state = mapCursorMessage(scoped('child', { sessionUpdate: 'tool_call', toolCallId: 'child-todos', kind: 'other', title: 'Todos', status: 'in_progress' }), state).state;
    const mapped = mapCursorMessage({ method: 'cursor/update_todos', params: { toolCallId: 'child-todos', merge: false, todos: [{ id: 'a', content: 'Child work', status: 'pending' }] } }, state);
    expect(mapped.events.some(e => e.type === 'plan.updated')).toBe(false);
    expect(mapped.state.todos.size).toBe(0);
  });

  it('child terminal flushes its text and task without ending the parent turn', () => {
    const announced = mapCursorMessage(spawn(), start());
    const child = mapCursorMessage(chunk('child', 'Done'), announced.state);
    const terminal = mapCursorMessage(scoped('s', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed', _meta: { cursor: { toolCallId: 'task', agentId: 'child' } } }), child.state);
    expect(terminal.events).toMatchObject([
      { type: 'item.completed', item: { kind: 'message', text: 'Done', parentItemId: 'task' } },
      { type: 'item.completed', item: { kind: 'tool', id: 'task', toolKind: 'task', status: 'completed' } },
    ]);
    expect(terminal.events.some((event) => event.type === 'turn.completed')).toBe(false);
    expect(terminal.state.turnId).toBe('turn_1');
    expect(mapCursorMessage(chunk('child', 'late'), terminal.state).events).toEqual([]);
    expect(mapCursorMessage(spawn('unknown', 'intruder'), terminal.state).state).toBe(terminal.state);
  });

  it('nests grandchildren under scoped tools and rejects forged terminal ownership', () => {
    let state = mapCursorMessage(spawn(), start()).state;
    const nested = mapCursorMessage(spawn('child', 'grandchild', 'nested-task'), state);
    state = nested.state;
    const task = nested.events.find((event) => event.type === 'item.started');
    expect(task).toMatchObject({ item: { toolKind: 'task', parentItemId: 'task' } });
    const scopedTaskId = task?.type === 'item.started' ? task.item.id : '';
    const child = mapCursorMessage(chunk('grandchild', 'nested'), state);
    expect(child.events).toMatchObject([{ item: { parentItemId: scopedTaskId, text: 'nested' } }]);
    const forged = mapCursorMessage(scoped('s', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'grandchild', state: 'failed' }), child.state);
    expect(forged.state).toBe(child.state);
    const ended = cursorTurnCompleted('cancelled', child.state);
    expect(ended.events).toContainEqual(expect.objectContaining({ type: 'item.completed', item: expect.objectContaining({ text: 'nested', parentItemId: scopedTaskId }) }));
    expect(ended.events.filter((event) => event.type === 'turn.completed')).toHaveLength(1);
  });
});
