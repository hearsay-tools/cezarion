import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from './ui-events.ts';
import { createCursorPrintUiState, mapCursorPrintMessage, mapCursorPrintStreamEvent } from './cursor-print-ui-mapper.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'cursor');

function replay(name: string): UiEvent[] {
  let state = createCursorPrintUiState();
  const events: UiEvent[] = [];
  for (const line of readFileSync(join(fixtures, name), 'utf8').trim().split('\n')) {
    const mapped = mapCursorPrintMessage(JSON.parse(line) as unknown, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return events;
}

describe('Cursor print mapper', () => {
  it('maps two native print turns as one logical session with independent golden expectations', () => {
    expect(JSON.parse(JSON.stringify(replay('print-lifecycle.ndjson')))).toStrictEqual(
      JSON.parse(readFileSync(join(fixtures, 'print-lifecycle.expected.json'), 'utf8')),
    );
  });

  it('treats an auto-rejected native question as one failed tool, without a Cezar ASK', () => {
    const events = replay('print-native-question.ndjson');
    const question = events.filter(event => event.type === 'item.completed' && event.item.kind === 'tool');
    expect(question).toHaveLength(1);
    expect(question[0]).toMatchObject({ type: 'item.completed', item: {
      id: 'call_question_1', status: 'failed',
      error: 'Cursor skipped this native question in headless print mode',
    } });
    expect(events.filter(event => event.type === 'ask.requested')).toHaveLength(0);
  });

  it('keeps input state immutable and malformed frames inert', () => {
    const state = createCursorPrintUiState();
    const before = { ...state };
    expect(mapCursorPrintMessage(null, state)).toEqual({ state, events: [] });
    expect(mapCursorPrintMessage({ type: 'future' }, state)).toEqual({ state, events: [] });
    mapCursorPrintMessage({ type: 'system', subtype: 'init', session_id: 's' }, state);
    expect(state).toEqual(before);
  });

  it('ignores partial text, duplicate terminal frames and malformed init frames', () => {
    const initial = createCursorPrintUiState();
    expect(mapCursorPrintMessage({ type: 'system', subtype: 'init' }, initial).events).toEqual([]);
    const started = mapCursorPrintMessage({ type: 'system', subtype: 'init', session_id: 's' }, initial);
    expect(mapCursorPrintMessage({ type: 'system', subtype: 'init', session_id: 's' }, started.state).events).toEqual([]);
    const partial = mapCursorPrintMessage({ type: 'assistant', model_call_id: 'partial',
      message: { content: [{ type: 'text', text: 'duplicate' }] },
    }, started.state);
    expect(partial.events).toEqual([]);
    const complete = mapCursorPrintMessage({ type: 'assistant',
      message: { content: [{ type: 'text', text: 'one final message' }] },
    }, partial.state);
    expect(complete.events.filter(event => event.type === 'item.completed')).toHaveLength(1);
    const ended = mapCursorPrintMessage({ type: 'result', subtype: 'success', result: 'one final message' }, complete.state);
    expect(ended.events.filter(event => event.type === 'turn.completed')).toHaveLength(1);
    expect(mapCursorPrintMessage({ type: 'result', subtype: 'success', result: 'duplicate' }, ended.state).events).toEqual([]);
  });

  it('emits usage only when the terminal wire supplies directional counts', () => {
    const started = mapCursorPrintMessage({ type: 'system', subtype: 'init', session_id: 's' }, createCursorPrintUiState());
    const ended = mapCursorPrintMessage({ type: 'result', subtype: 'success', result: 'done',
      usage: { input_tokens: 12, output_tokens: 3 },
    }, started.state);
    expect(ended.events).toContainEqual({ type: 'usage.updated', usage: { input: 12, output: 3, total: 15 } });
    expect(ended.events).toContainEqual({ type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn',
      usage: { input: 12, output: 3, total: 15 },
    });
  });

  it('ends a reported provider error as a failed turn without a success message', () => {
    const started = mapCursorPrintMessage({ type: 'system', subtype: 'init', session_id: 's' }, createCursorPrintUiState());
    const ended = mapCursorPrintMessage({ type: 'result', subtype: 'error_during_execution',
      is_error: true, result: 'provider unavailable',
    }, started.state);
    expect(ended.events).toEqual([{ type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' }]);
    expect(mapCursorPrintStreamEvent({ type: 'result', subtype: 'error_during_execution',
      is_error: true, result: 'provider unavailable',
    })).toContainEqual({ type: 'error', message: 'provider unavailable' });
  });

  it('marks a rejected native question as a failed v1 tool result', () => {
    expect(mapCursorPrintStreamEvent({ type: 'tool_call', subtype: 'completed', call_id: 'q',
      tool_call: { askQuestionToolCall: { result: { rejected: { reason: 'skipped' } } } },
    })).toEqual([{ type: 'tool-result', toolCallId: 'q', result: JSON.stringify({ rejected: { reason: 'skipped' } }), isError: true }]);
  });
});
