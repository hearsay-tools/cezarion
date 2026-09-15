import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent, UiMessageItem } from './ui-events.js';
import {
  createPiUiState,
  mapPiRpcMessage,
  piTurnStarted,
  type PiUiMapperState,
  type PiUiMapping,
} from './pi-ui-mapper.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'pi');

function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: PiUiMapperState = createPiUiState();
  const events: UiEvent[] = [];
  const push = (mapped: PiUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  push(piTurnStarted(state));
  for (const line of lines) push(mapPiRpcMessage(JSON.parse(line), state));
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

const GOLDEN_FIXTURES = [
  'rpc-lifecycle',
  // Persisted Pi session 3f60d363-22c6-4400-b60a-a2b76f0e405c (run c958f3c4,
  // issue #54): empty assistant message_end with stopReason error and a
  // provider_transport_failure diagnostic. RPC wrapping matches the runner's
  // stdout, not the on-disk JSONL envelope.
  'provider-error',
] as const;

describe('pi RPC → v2 golden fixture', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(`maps ${fixture} to the exact UiEvent sequence`, () => {
      const expected = JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
      expect(replay(fixture)).toStrictEqual(expected);
    });
  }

  it('malformed and unknown RPC messages are ignored without throwing', () => {
    const state = createPiUiState();
    for (const value of [null, 42, [], {}, { type: 'future_event' }]) {
      const mapped = mapPiRpcMessage(value, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  it('maps upstream model stop reasons onto the normalized turn reason', () => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'done', reason: 'length', message: {} },
      },
      state,
    ).state;
    expect(mapPiRpcMessage({ type: 'agent_settled' }, state).events).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'max_tokens' },
    ]);
  });

  it.each([
    { type: 'message_update', assistantMessageEvent: { type: 'future_update', contentIndex: 0 } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0 } },
    { type: 'message_end', message: { role: 'user' } },
    { type: 'tool_execution_start', toolCallId: '', toolName: 'edit', args: {} },
  ])('does not synthesize a turn for invalid post-settlement activity: $type', (value) => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage({ type: 'agent_settled' }, state).state;

    const mapped = mapPiRpcMessage(value, state);

    expect(mapped.events).toEqual([]);
    expect(mapped.state.turnId).toBeNull();
    expect(mapped.state.turnSeq).toBe(1);
  });

  it.each([
    {
      value: {
        type: 'tool_execution_update',
        toolCallId: 'late-tool',
        partialResult: { content: [{ type: 'text', text: 'still working' }] },
      },
      eventType: 'item.updated',
    },
    {
      value: {
        type: 'tool_execution_end',
        toolCallId: 'late-tool',
        result: { content: [{ type: 'text', text: 'finished' }] },
        isError: false,
      },
      eventType: 'item.completed',
    },
  ])('reopens a settled turn for a valid late tool frame: $eventType', ({ value, eventType }) => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage(
      { type: 'tool_execution_start', toolCallId: 'late-tool', toolName: 'edit', args: { path: 'a.ts' } },
      state,
    ).state;
    state = mapPiRpcMessage({ type: 'agent_settled' }, state).state;

    const mapped = mapPiRpcMessage(value, state);

    expect(mapped.events).toMatchObject([
      { type: 'turn.started', turnId: 'turn_2' },
      { type: eventType },
    ]);
    expect(mapped.state.turnId).toBe('turn_2');
  });
});

function feed(messages: unknown[]): UiEvent[] {
  let mapped = piTurnStarted(createPiUiState());
  const events = [...mapped.events];
  let state = mapped.state;
  for (const value of messages) {
    mapped = mapPiRpcMessage(value, state);
    events.push(...mapped.events);
    state = mapped.state;
  }
  return events;
}

function textUpdate(type: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'message_update',
    assistantMessageEvent: { type, contentIndex: 0, ...extra },
  };
}

function completedMessages(events: UiEvent[]): UiMessageItem[] {
  return events.flatMap((e) =>
    e.type === 'item.completed' && e.item.kind === 'message' ? [e.item] : [],
  );
}

describe('pi text blocks as distinct v2 items', () => {
  it('does not start an item for a text_start that carries neither a delta nor an end', () => {
    const events = feed([textUpdate('text_start')]);
    expect(events.filter((e) => e.type !== 'turn.started')).toEqual([]);
  });

  it('renders prose before and after a tool as two completed messages when both use contentIndex 0', () => {
    const events = feed([
      textUpdate('text_delta', { delta: 'before' }),
      textUpdate('text_end', { content: 'before' }),
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } },
      {
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'read',
        isError: false,
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
      textUpdate('text_delta', { delta: 'after' }),
      textUpdate('text_end', { content: 'after' }),
    ]);
    const completed = completedMessages(events);
    expect(completed.map((item) => item.text)).toEqual(['before', 'after']);
    expect(completed[0]!.id).not.toBe(completed[1]!.id);
  });

  it('closes a dangling open text item exactly once when the turn completes', () => {
    const events = feed([textUpdate('text_delta', { delta: 'partial' }), { type: 'agent_settled' }]);
    const completed = completedMessages(events);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.text).toBe('partial');
    const settleAt = events.findIndex((e) => e.type === 'turn.completed');
    expect(events[settleAt - 1]).toMatchObject({ type: 'item.completed', item: completed[0] });
  });

  it('does not complete an already-ended text item again on turn completion', () => {
    const events = feed([
      textUpdate('text_delta', { delta: 'hi' }),
      textUpdate('text_end', { content: 'hi' }),
      { type: 'agent_settled' },
    ]);
    expect(completedMessages(events)).toHaveLength(1);
  });

  it('ignores a malformed tool_execution_start without closing open text', () => {
    const events = feed([
      textUpdate('text_delta', { delta: 'partial' }),
      { type: 'tool_execution_start' },
      { type: 'agent_settled' },
    ]);
    expect(events.some((e) => e.type === 'item.started' && e.item.kind === 'tool')).toBe(false);
    const completed = completedMessages(events);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.text).toBe('partial');
  });

  it('gives a second assistant message its own item after message_end when both use contentIndex 0', () => {
    const events = feed([
      textUpdate('text_delta', { delta: 'first' }),
      textUpdate('text_end', { content: 'first' }),
      {
        type: 'message_end',
        message: { role: 'assistant', usage: { input: 1, output: 1, totalTokens: 2 } },
      },
      textUpdate('text_delta', { delta: 'second' }),
      textUpdate('text_end', { content: 'second' }),
    ]);
    const completed = completedMessages(events);
    expect(completed.map((item) => item.text)).toEqual(['first', 'second']);
    expect(completed[0]!.id).not.toBe(completed[1]!.id);
  });

  it('ignores a malformed message_end without closing open text', () => {
    const events = feed([
      textUpdate('text_delta', { delta: 'Hello' }),
      { type: 'message_end' },
      textUpdate('text_delta', { delta: ' world' }),
      textUpdate('text_end', { content: 'Hello world' }),
    ]);
    const completed = completedMessages(events);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.text).toBe('Hello world');
  });
});

function assistantEnd(extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      ...extra,
    },
  };
}

describe('pi assistant message_end provider failures (#54)', () => {
  it('falls back to errorMessage when there is no transport diagnostic', () => {
    const events = feed([
      assistantEnd({
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        stopReason: 'error',
        errorMessage: 'Not Found',
      }),
      { type: 'agent_settled' },
    ]);
    expect(events).toContainEqual({
      type: 'session.error',
      message: 'pi: openai-codex/gpt-5.6-sol request failed: Not Found',
      fatal: false,
    });
    expect(events.filter((e) => e.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' },
    ]);
  });

  it('does not leak diagnostic stacks or details into session.error', () => {
    const events = replay('provider-error');
    const error = events.find((e) => e.type === 'session.error');
    expect(error).toEqual({
      type: 'session.error',
      message: 'pi: openai-codex/gpt-5.6-sol request failed: WebSocket error',
      fatal: false,
    });
    expect(JSON.stringify(error)).not.toMatch(/extractWebSocketError|requestBytes|sk-|Bearer /i);
  });

  it('keeps a successful empty assistant turn as end_turn', () => {
    const events = feed([assistantEnd(), { type: 'agent_settled' }]);
    expect(events.some((e) => e.type === 'session.error')).toBe(false);
    expect(events.filter((e) => e.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' },
    ]);
  });

  it('clears stopReason after a later successful assistant message_end in the same turn (#277)', () => {
    const events = feed([
      assistantEnd({
        provider: 'openai-completions',
        model: 'grok-4',
        stopReason: 'error',
        errorMessage: 'Internal error during token generation',
      }),
      assistantEnd(),
      { type: 'agent_settled' },
    ]);
    expect(events.filter((e) => e.type === 'session.error')).toEqual([
      {
        type: 'session.error',
        message: 'pi: openai-completions/grok-4 request failed: Internal error during token generation',
        fatal: false,
      },
    ]);
    expect(events.filter((e) => e.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'end_turn' },
    ]);
  });

  it('keeps stopReason error when the turn settles on the failed attempt (#277)', () => {
    const events = feed([
      assistantEnd({
        stopReason: 'error',
        errorMessage: 'Internal error during token generation',
      }),
      { type: 'agent_settled' },
    ]);
    expect(events.filter((e) => e.type === 'session.error')).toEqual([
      {
        type: 'session.error',
        message: 'pi: provider request failed: Internal error during token generation',
        fatal: false,
      },
    ]);
    expect(events.filter((e) => e.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'error' },
    ]);
  });
});
