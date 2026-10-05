import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent, UiItem, UiToolItem } from './ui-events.js';
import {
  createOmpUiState,
  mapOmpRpcMessage,
  ompFlushProviderError,
  ompProviderErrorMessage,
  ompTurnBoundary,
  ompTurnStarted,
  type OmpUiMapperState,
  type OmpUiMapping,
} from './omp-ui-mapper.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'omp');
const GOLDEN_FIXTURES = ['rpc-lifecycle', 'rpc-edit-todo', 'rpc-subagents', 'rpc-retry'] as const;

function frames(fixture: string): unknown[] {
  return readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

/** Folds `mapOmpRpcMessage` over a frame list, opening the turn first as the runner does
 *  when it writes the `prompt` (id `p`). */
function fold(values: readonly unknown[], start: OmpUiMapperState = ompTurnStarted(createOmpUiState(), 'p').state) {
  let state = start;
  const events: UiEvent[] = start.turnId ? [{ type: 'turn.started', turnId: start.turnId }] : [];
  const perFrame: UiEvent[][] = [];
  const push = (mapped: OmpUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
    perFrame.push(mapped.events);
  };
  for (const value of values) push(mapOmpRpcMessage(value, state));
  return { events: JSON.parse(JSON.stringify(events)) as UiEvent[], perFrame, state };
}

function replay(fixture: string): UiEvent[] {
  return fold(frames(fixture)).events;
}

function expected(fixture: string): UiEvent[] {
  return JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8')) as UiEvent[];
}

/** The last reported shape of every item that completed. */
function completedItems(events: UiEvent[]): UiItem[] {
  const byId = new Map<string, UiItem>();
  for (const event of events) if (event.type === 'item.completed') byId.set(event.item.id, event.item);
  return [...byId.values()];
}

function toolItems(events: UiEvent[]): UiToolItem[] {
  return completedItems(events).filter((item): item is UiToolItem => item.kind === 'tool');
}

describe('omp ui mapper (golden fixtures)', () => {
  it.each(GOLDEN_FIXTURES)('%s replays to its expected events', (name) => {
    expect(replay(name)).toStrictEqual(expected(name));
  });

  it('starts the session from the recorded get_state response', () => {
    const started = replay('rpc-lifecycle').filter((event) => event.type === 'session.started');
    expect(started).toEqual([
      {
        type: 'session.started',
        sessionId: '01a108f7-7ffa-7134-93b2-09b71ed8e347',
        backend: 'omp',
        model: 'claude-opus-5-5',
      },
    ]);
  });

  it('ignores the unsolicited startup frames (Ruling 7) and the set_* acknowledgements', () => {
    const state = createOmpUiState();
    for (const value of frames('rpc-lifecycle').slice(0, 8)) {
      const mapped = mapOmpRpcMessage(value, state);
      if ((value as { command?: string }).command === 'get_state') continue;
      expect(mapped.events).toEqual([]);
    }
  });

  it('agent_end with yielded false does not complete the turn', () => {
    const values = frames('rpc-retry');
    const { perFrame } = fold(values);
    const settledAt = values.findIndex((value) => (value as { type: string }).type === 'session_settled');
    const completedAt = perFrame.map((events, index) => (events.some((e) => e.type === 'turn.completed') ? index : -1)).filter((i) => i >= 0);
    expect(completedAt).toEqual([settledAt]);
    const yieldedFalse = values.findIndex(
      (value) => (value as { type: string; yielded?: boolean }).type === 'agent_end' && (value as { yielded?: boolean }).yielded === false,
    );
    expect(perFrame[yieldedFalse]).toEqual([]);
  });

  it('a recovered retry emits no session.error', () => {
    const events = replay('rpc-retry');
    expect(events.some((event) => event.type === 'session.error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', stopReason: 'end_turn' });
  });

  it('a retry that never recovers releases the latched provider error at session_settled', () => {
    const values = frames('rpc-retry').filter((value) => {
      const frame = value as { type: string; message?: { stopReason?: string } };
      return !(frame.type === 'message_end' && frame.message?.stopReason === 'stop');
    });
    const events = fold(values).events;
    expect(events.filter((event) => event.type === 'session.error')).toEqual([
      {
        type: 'session.error',
        message: 'omp: anthropic/claude-opus-5-5 request failed: 529 overloaded_error: Overloaded',
        fatal: false,
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', stopReason: 'error' });
  });

  it('child agent_end inside subagent_event never completes the parent turn', () => {
    const values = frames('rpc-subagents');
    const { perFrame } = fold(values);
    const settledAt = values.findIndex((value) => (value as { type: string }).type === 'session_settled');
    perFrame.forEach((events, index) => {
      if (index !== settledAt) expect(events.some((event) => event.type === 'turn.completed')).toBe(false);
    });
    // A settle-shaped child frame is not a boundary either.
    let state = ompTurnStarted(createOmpUiState()).state;
    for (const value of values.slice(0, 12)) state = mapOmpRpcMessage(value, state).state;
    for (const event of [{ type: 'session_settled' }, { type: 'agent_end', yielded: true, isTerminal: true }]) {
      const mapped = mapOmpRpcMessage({ type: 'subagent_event', payload: { id: 'RpcMapper', event } }, state);
      expect(mapped.events.some((e) => e.type === 'turn.completed')).toBe(false);
      expect(mapped.state.turnId).toBe(state.turnId);
    }
  });

  it('batch task yields one task row per sub-agent and no task-kind batch card', () => {
    const items = toolItems(replay('rpc-subagents'));
    expect(items.filter((i) => i.toolKind === 'task' && !i.parentItemId)).toHaveLength(5); // 2 single + 3 batch
    expect(items.find((i) => i.title === 'Task batch · 3 agents')?.toolKind).toBe('other');
    const single = mapOmpRpcMessage({ type: 'tool_execution_start', toolCallId: 'one', toolName: 'task', args: { tasks: [{ agent: 'explore', task: 'read a.txt' }] } }, createOmpUiState());
    expect(single.events.find((e) => e.type === 'item.started')).toMatchObject({ item: { title: 'Task batch · 1 agent' } });
    const rows = Object.fromEntries(items.filter((i) => i.id.startsWith('toolu_task_2#')).map((i) => [i.id, i]));
    expect(rows['toolu_task_2#Docs']).toMatchObject({
      name: 'task',
      title: 'Task: Read the RPC docs',
      status: 'completed',
      input: { agent: 'explore', task: 'Summarise docs/rpc.md' },
    });
    expect(rows['toolu_task_2#Types']).toMatchObject({ title: 'Task: List every frame in rpc-types.ts', status: 'completed' });
    expect(rows['toolu_task_2#Tests']).toMatchObject({ status: 'failed', input: { agent: 'task', task: 'Draft mapper tests' } });
  });

  it('nests child work under its sub-agent row and keeps it out of the parent text', () => {
    const events = replay('rpc-subagents');
    const items = completedItems(events);
    const child = (rowId: string) => items.filter((item) => item.parentItemId === rowId);
    expect(child('toolu_task_1').map((item) => item.kind).sort()).toEqual(['message', 'tool']);
    expect(child('toolu_task_2#Docs').map((item) => item.kind)).toEqual(['message']);
    expect(child('toolu_task_2#Types').map((item) => item.kind)).toEqual(['tool']);
    // The aborted agent's unfinished text block closes with its lifecycle, still nested.
    expect(child('toolu_task_2#Tests')).toEqual([
      expect.objectContaining({ kind: 'message', text: 'Starting on the lifecycle fixture' }),
    ]);
    // Child usage never moves the parent's usage panel.
    expect(events.filter((event) => event.type === 'usage.updated')).toHaveLength(2);
  });

  it('sub-agent events before their lifecycle frame are replayed once it arrives', () => {
    const values = frames('rpc-subagents');
    const lifecycleAt = values.findIndex((value) => (value as { type: string }).type === 'subagent_lifecycle');
    const { perFrame } = fold(values);
    for (let index = 0; index < lifecycleAt; index += 1) {
      expect(perFrame[index]!.some((event) => 'item' in event && event.item.parentItemId !== undefined)).toBe(false);
    }
    expect(perFrame[lifecycleAt]).toContainEqual({
      type: 'item.started',
      item: { kind: 'message', id: 'toolu_task_1/text_0_0', role: 'assistant', text: '', parentItemId: 'toolu_task_1' },
    });
  });

  it('bounds the early sub-agent buffer and reports the drop once', () => {
    let state = ompTurnStarted(createOmpUiState()).state;
    const errors: UiEvent[] = [];
    const send = (id: string): void => {
      const mapped = mapOmpRpcMessage({ type: 'subagent_event', payload: { id, event: { type: 'agent_start' } } }, state);
      state = mapped.state;
      errors.push(...mapped.events.filter((event) => event.type === 'session.error'));
    };
    for (let index = 0; index < 201; index += 1) send('A');
    for (let index = 0; index < 8; index += 1) send(`B${index}`);
    expect(state.pendingSubagentEvents.get('A')).toHaveLength(200);
    expect(state.pendingSubagentEvents.size).toBe(8);
    expect(state.pendingSubagentEvents.has('B7')).toBe(false);
    expect(errors).toEqual([{ type: 'session.error', message: 'omp: sub-agent events dropped before lifecycle', fatal: false }]);
  });

  it('omp mapper tolerates every fixture frame with each field removed', () => {
    for (const fixture of GOLDEN_FIXTURES) {
      const values = frames(fixture);
      let warm = ompTurnStarted(createOmpUiState()).state;
      for (const value of values) {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          const trimmed = { ...(value as Record<string, unknown>) };
          delete trimmed[key];
          expect(() => mapOmpRpcMessage(trimmed, createOmpUiState())).not.toThrow();
          expect(() => mapOmpRpcMessage(trimmed, warm)).not.toThrow();
          const payload = (value as { payload?: unknown }).payload;
          if (payload && typeof payload === 'object') {
            for (const inner of Object.keys(payload)) {
              const partial = { ...(payload as Record<string, unknown>) };
              delete partial[inner];
              expect(() => mapOmpRpcMessage({ ...trimmed, type: (value as { type: string }).type, payload: partial }, warm)).not.toThrow();
            }
          }
        }
        warm = mapOmpRpcMessage(value, warm).state;
      }
    }
  });

  it('malformed and unknown frames are ignored without throwing', () => {
    const state = createOmpUiState();
    for (const value of [null, 42, [], {}, { type: 'future_event' }, { type: 'subagent_event' }, { type: 'subagent_lifecycle', payload: 7 }]) {
      const mapped = mapOmpRpcMessage(value, state);
      expect(mapped.events).toEqual([]);
    }
  });

  it('ompTurnBoundary recognises session_settled, prompt_result agentInvoked false and the prompt response form', () => {
    expect(ompTurnBoundary({ type: 'session_settled' })).toBe('settled');
    expect(ompTurnBoundary({ type: 'prompt_result', id: 'p', agentInvoked: false, status: 'completed', sessionSettled: true })).toBe('local');
    expect(ompTurnBoundary({ type: 'prompt_result', id: 'p', agentInvoked: false, status: 'error', sessionSettled: true })).toBe('local');
    expect(ompTurnBoundary({ id: 'p', type: 'response', command: 'prompt', success: true, data: { agentInvoked: false } })).toBe('local');
    expect(ompTurnBoundary({ type: 'prompt_result', id: 'p', agentInvoked: true, status: 'completed', sessionSettled: true })).toBeNull();
    expect(ompTurnBoundary({ id: 'p', type: 'response', command: 'prompt', success: true })).toBeNull();
    expect(ompTurnBoundary({ id: 'p', type: 'response', command: 'prompt', success: false, data: { agentInvoked: false } })).toBeNull();
    expect(ompTurnBoundary({ type: 'agent_end', yielded: true, isTerminal: true })).toBeNull();
    expect(ompTurnBoundary({ type: 'agent_settled' })).toBeNull();
    expect(ompTurnBoundary(null)).toBeNull();
  });

  it('a locally completed prompt ends the turn without waiting for session_settled', () => {
    const response = fold([{ id: 'p', type: 'response', command: 'prompt', success: true, data: { agentInvoked: false } }]);
    expect(response.events.at(-1)).toEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' });
    const result = fold([{ type: 'prompt_result', id: 'p', agentInvoked: false, status: 'completed', sessionSettled: true }]);
    expect(result.events.at(-1)).toEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' });
  });

  it('a prompt that fails after admission reports the error once and ends the turn at its prompt_result', () => {
    // rpc-mode.ts v18.4.11: the success ack, then `onError`'s failure response, then `fail()`'s
    // `prompt_result` (agentInvoked false) with the same id.
    const { events, perFrame } = fold([
      { id: 'p', type: 'response', command: 'prompt', success: true },
      { id: 'p', type: 'response', command: 'prompt', success: false, error: 'No API key for anthropic' },
      {
        type: 'prompt_result',
        id: 'p',
        agentInvoked: false,
        status: 'error',
        error: { message: 'No API key for anthropic', provider: 'anthropic', model: 'claude-opus-5-5', retryable: false },
        sessionSettled: true,
      },
    ]);
    // The failure response reports it; its `prompt_result` (same id) only ends the turn.
    expect(perFrame[1]).toEqual([{ type: 'session.error', message: 'omp: prompt failed: No API key for anthropic', fatal: false }]);
    expect(events.slice(1)).toEqual([
      { type: 'session.error', message: 'omp: prompt failed: No API key for anthropic', fatal: false },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' },
    ]);
  });

  it('the turn-opening prompt failing before admission reports the error and ends the turn as error (Ruling 10)', () => {
    // rpc.md: a failure before admission is the command's error response, and no
    // `prompt_result` follows (rpc-mode.ts discards the ticket).
    const { events, state } = fold([
      { id: 'p', type: 'response', command: 'prompt', success: false, error: 'input hook rejected the prompt' },
    ]);
    expect(events.slice(1)).toEqual([
      { type: 'session.error', message: 'omp: prompt failed: input hook rejected the prompt', fatal: false },
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' },
    ]);
    expect(state.turnId).toBeNull();
  });

  it('a steer failing before admission reports the error and keeps the running turn open', () => {
    const { events, state } = fold([
      { id: 'p', type: 'response', command: 'prompt', success: true },
      { id: 's', type: 'response', command: 'prompt', success: false, error: 'input hook rejected the steer' },
    ]);
    expect(events.slice(1)).toEqual([
      { type: 'session.error', message: 'omp: prompt failed: input hook rejected the steer', fatal: false },
    ]);
    expect(state.turnId).toBe('turn_1');
  });

  it('a steer completed locally or failing mid-turn never ends the running turn', () => {
    const { events, perFrame } = fold([
      { id: 'p', type: 'response', command: 'prompt', success: true },
      { id: 's1', type: 'response', command: 'prompt', success: true, data: { agentInvoked: false } },
      { id: 's2', type: 'response', command: 'prompt', success: true },
      { type: 'prompt_result', id: 's2', agentInvoked: false, status: 'completed', sessionSettled: false },
      { id: 's3', type: 'response', command: 'prompt', success: true },
      { type: 'prompt_result', id: 's3', agentInvoked: false, status: 'error', error: { message: 'steer failed' }, sessionSettled: false },
      { type: 'session_settled' },
    ]);
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' },
    ]);
    expect(perFrame.at(-1)?.at(-1)).toEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' });
    expect(events).toContainEqual({ type: 'session.error', message: 'omp: provider request failed: steer failed', fatal: false });
  });

  it('a local boundary never ends a turn no prompt opened', () => {
    // Activity after a settle re-opens a turn on its own (OMP woke up); a prompt finished
    // locally while it runs is someone else's.
    const { events, state } = fold(
      [
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'woke' } },
        { type: 'prompt_result', agentInvoked: false, status: 'completed', sessionSettled: false },
        { id: 's', type: 'response', command: 'prompt', success: true, data: { agentInvoked: false } },
      ],
      createOmpUiState(),
    );
    expect(events.filter((event) => event.type === 'turn.completed')).toEqual([]);
    expect(state.turnId).toBe('turn_1');
  });

  it('dedupes a prompt_result error only for the prompt whose response already failed', () => {
    const result = (id: string) => ({
      type: 'prompt_result',
      id,
      agentInvoked: false,
      status: 'error',
      error: { message: 'boom', retryable: false },
      sessionSettled: true,
    });
    const { events } = fold([
      { id: 'a', type: 'response', command: 'prompt', success: false, error: 'boom' },
      result('b'),
    ]);
    expect(events.filter((event) => event.type === 'session.error').map((event) => event.message)).toEqual([
      'omp: prompt failed: boom',
      'omp: provider request failed: boom',
    ]);
  });

  it('a reused sub-agent id under a new parent call opens a new row instead of reusing the old one', () => {
    // v18.4.11 `AgentOutputManager.allocate` keeps ids unique within one session, but a
    // `new_session` in the same RPC process starts a fresh allocator; events carry only the id.
    const batch = (callId: string) => ({
      type: 'tool_execution_start',
      toolCallId: callId,
      toolName: 'task',
      args: { context: 'c', tasks: [{ name: 'Anna', agent: 'explore', task: `work for ${callId}`, solutionSpace: 's' }] },
    });
    const lifecycle = (callId: string, status: string) => ({
      type: 'subagent_lifecycle',
      payload: { id: 'Anna', agent: 'explore', status, parentToolCallId: callId, index: 0 },
    });
    const text = {
      type: 'subagent_event',
      payload: { id: 'Anna', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' } } },
    };
    const { events } = fold([batch('A'), lifecycle('A', 'started'), lifecycle('A', 'completed'), batch('B'), lifecycle('B', 'started'), text]);
    expect(events).toContainEqual({
      type: 'item.started',
      item: expect.objectContaining({ id: 'B#Anna', title: 'Task: work for B', status: 'running' }),
    });
    expect(events).toContainEqual({
      type: 'item.started',
      item: expect.objectContaining({ kind: 'message', parentItemId: 'B#Anna' }),
    });
    expect(events.some((event) => 'item' in event && event.item.parentItemId === 'A#Anna')).toBe(false);
  });

  describe('a single-form task row follows its sub-agent lifecycle (final review #4)', () => {
    // v18.4.11 runs `task` asynchronously in RPC by default (`async.enabled`, protocolDefault
    // ["rpc"]): the call can return while its sub-agent still runs, so the row's status is the
    // lifecycle's, not the tool result's.
    const start = { type: 'tool_execution_start', toolCallId: 'T', toolName: 'task', args: { agent: 'explore', task: 'watch CI', solutionSpace: 's' } };
    const lifecycle = (status: string) => ({
      type: 'subagent_lifecycle',
      payload: { id: 'Watcher', agent: 'explore', status, parentToolCallId: 'T', index: 0 },
    });
    const end = (isError = false) => ({
      type: 'tool_execution_end', toolCallId: 'T', toolName: 'task', isError,
      result: { content: [{ type: 'text', text: 'Watcher: running in the background' }] },
    });
    const rowEvents = (events: UiEvent[]) => events.filter((event) => 'item' in event && event.item.id === 'T');

    it('stays running past an early tool result and completes with the agent', () => {
      const { events } = fold([start, lifecycle('started'), end(), lifecycle('completed')]);
      expect(rowEvents(events).map((event) => [event.type, (event as { item: UiToolItem }).item.status])).toEqual([
        ['item.started', 'running'],
        ['item.updated', 'running'],
        ['item.completed', 'completed'],
      ]);
      expect(rowEvents(events).at(-1)).toMatchObject({ item: { output: 'Watcher: running in the background' } });
    });

    it('an agent aborted after the tool result fails the row', () => {
      const { events } = fold([start, lifecycle('started'), end(), lifecycle('aborted')]);
      expect(rowEvents(events).at(-1)).toMatchObject({ type: 'item.completed', item: { status: 'failed' } });
    });

    it('an agent aborted before a successful tool result still fails the row', () => {
      const { events } = fold([start, lifecycle('started'), lifecycle('aborted'), end()]);
      expect(rowEvents(events).map((event) => event.type)).toEqual(['item.started', 'item.completed']);
      expect(rowEvents(events).at(-1)).toMatchObject({ item: { status: 'failed' } });
    });

    it('a failed tool result completes the row at once, and a later lifecycle frame leaves it alone', () => {
      const { events } = fold([start, lifecycle('started'), end(true), lifecycle('completed')]);
      expect(rowEvents(events).map((event) => [event.type, (event as { item: UiToolItem }).item.status])).toEqual([
        ['item.started', 'running'],
        ['item.completed', 'failed'],
      ]);
    });

    it('a task call with no lifecycle frame completes on its result, as before', () => {
      const { events } = fold([start, end()]);
      expect(rowEvents(events).at(-1)).toMatchObject({ type: 'item.completed', item: { status: 'completed' } });
    });
  });

  it('agent-invoked prompt_result waits for session_settled', () => {
    const { events } = fold([{ type: 'prompt_result', id: 'p', agentInvoked: true, status: 'completed', sessionSettled: false }]);
    expect(events).toEqual([{ type: 'turn.started', turnId: 'turn_1' }]);
  });

  it('maps failed responses, extension errors and error notices to non-fatal session errors', () => {
    const state = createOmpUiState();
    expect(mapOmpRpcMessage({ id: 'x', type: 'response', command: 'get_subagents', success: false, error: 'boom' }, state).events).toEqual([
      { type: 'session.error', message: 'boom', fatal: false },
    ]);
    expect(mapOmpRpcMessage({ id: 'm1', type: 'response', command: 'set_steering_mode', success: false, error: 'nope' }, state).events).toEqual([]);
    expect(mapOmpRpcMessage({ type: 'extension_error', extensionPath: '/x.ts', event: 'tool', error: 'ext broke' }, state).events).toEqual([
      { type: 'session.error', message: 'ext broke', fatal: false },
    ]);
    expect(mapOmpRpcMessage({ type: 'notice', level: 'error', message: 'session file not writable' }, state).events).toEqual([
      { type: 'session.error', message: 'session file not writable', fatal: false },
    ]);
    expect(mapOmpRpcMessage({ type: 'notice', level: 'warning', message: 'slow disk' }, state).events).toEqual([]);
  });

  it('derives diffs from the edit result, falling back to replace-mode args', () => {
    const items = toolItems(replay('rpc-edit-todo'));
    expect(items.find((item) => item.id === 'toolu_edit_1')).toMatchObject({
      title: 'Edit src/greet.ts',
      diffs: [{ path: 'src/greet.ts', oldText: "export function greet() {\n  return 'hi';\n}\n", newText: "export function greet() {\n  return 'hello';\n}\n" }],
    });
    expect(items.find((item) => item.id === 'toolu_edit_2')?.diffs).toEqual([
      { path: 'src/a.ts', oldText: 'export const a = 1;\n', newText: 'export const a = 2;\n' },
      { path: 'src/b.ts', oldText: null, newText: 'export const b = 2;\n' },
    ]);
    expect(items.find((item) => item.id === 'toolu_write_1')?.diffs).toEqual([{ path: 'docs/notes.md', oldText: null, newText: '# Notes\n' }]);

    const replace = fold([
      { type: 'tool_execution_start', toolCallId: 'e', toolName: 'edit', args: { path: 'a.ts', old_string: 'x', new_string: 'y' } },
      { type: 'tool_execution_end', toolCallId: 'e', toolName: 'edit', result: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    expect(toolItems(replace.events)[0]?.diffs).toEqual([{ path: 'a.ts', oldText: 'x', newText: 'y' }]);
  });

  it('builds the plan from todo results, mapping abandoned and blocked, and skips view', () => {
    const plans = replay('rpc-edit-todo').filter((event) => event.type === 'plan.updated');
    expect(plans).toHaveLength(3);
    expect(plans.at(-1)).toEqual({
      type: 'plan.updated',
      entries: [
        { content: 'Write mapper', status: 'completed' },
        { content: 'Add fixtures', status: 'in_progress' },
        { content: 'Run tests', status: 'pending' },
        { content: 'Publish', status: 'cancelled' },
      ],
    });
    const failed = fold([
      { type: 'tool_execution_start', toolCallId: 't', toolName: 'todo', args: { op: 'done', task: 'nope' } },
      { type: 'tool_execution_end', toolCallId: 't', toolName: 'todo', isError: true, result: { content: [], details: { phases: [] } } },
    ]);
    expect(failed.events.some((event) => event.type === 'plan.updated')).toBe(false);
  });

  it('holds turn usage and cost for turn.completed and clears it with the turn', () => {
    const events = replay('rpc-lifecycle');
    expect(events.at(-1)).toEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
      usage: { input: 1500, output: 40, total: 11740, cacheRead: 10200, cacheWrite: 0 },
      costUsd: 0.0081,
    });
  });

  it('flushes a latched provider error once', () => {
    let state = ompTurnStarted(createOmpUiState()).state;
    state = mapOmpRpcMessage(
      { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Not Found', provider: 'openai' } },
      state,
    ).state;
    const flushed = ompFlushProviderError(state);
    expect(flushed.events).toEqual([{ type: 'session.error', message: 'omp: openai request failed: Not Found', fatal: false }]);
    expect(ompFlushProviderError(flushed.state).events).toEqual([]);
  });

  it('prefixes provider errors with omp', () => {
    expect(ompProviderErrorMessage({})).toBe('omp: provider request failed');
    expect(ompProviderErrorMessage({ errorMessage: 'x' })).toBe('omp: provider request failed: x');
  });
});
