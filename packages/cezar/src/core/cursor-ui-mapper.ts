/** Pure ACP notification mapper. Transport, session filtering and asks belong to the runner.
 * Wire sources and vendor limitations: __fixtures__/cursor/README.md.
 */
import type { FileDiff, PlanEntry, StopReason, ToolKind, ToolStatus, UiEvent, UiMessageItem, UiReasoningItem, UiToolItem } from './ui-events.js';

export interface CursorUiState {
  readonly sessionId?: string;
  readonly turnSeq: number;
  readonly turnId?: string;
  readonly textSeq: number;
  readonly activeText?: UiMessageItem | UiReasoningItem;
  readonly tools: ReadonlyMap<string, UiToolItem>;
  readonly todos: ReadonlyMap<string, PlanEntry>;
}
export interface CursorUiMapping { state: CursorUiState; events: UiEvent[] }
export function createCursorUiState(): CursorUiState {
  return { turnSeq: 0, textSeq: 0, tools: new Map(), todos: new Map() };
}
export function cursorTurnStarted(state: CursorUiState): CursorUiMapping {
  const closed = flush(state);
  const turnSeq = state.turnSeq + 1;
  const turnId = `turn_${turnSeq}`;
  return { state: { ...closed.state, turnSeq, turnId }, events: [...closed.events, { type: 'turn.started', turnId }] };
}
export function cursorTurnCompleted(reason: string, state: CursorUiState): CursorUiMapping {
  if (!state.turnId) return { state, events: [] };
  const closed = flush(state);
  const { turnId, ...next } = closed.state;
  const stopReason: StopReason = reason === 'max_turn_requests' ? 'max_tokens'
    : ['end_turn', 'max_tokens', 'refusal', 'cancelled', 'timeout', 'error'].includes(reason) ? reason as StopReason : 'error';
  return { state: next, events: [...closed.events, { type: 'turn.completed', turnId: turnId!, stopReason }] };
}
function flush(state: CursorUiState): CursorUiMapping {
  if (!state.activeText) return { state, events: [] };
  const { activeText, ...next } = state;
  return { state: next, events: [{ type: 'item.completed', item: activeText }] };
}

export function mapCursorMessage(message: unknown, state: CursorUiState): CursorUiMapping {
  const noop = { state, events: [] };
  if (!record(message) || !record(message.params)) return noop;
  const params = message.params;
  if (message.method === 'cursor/update_todos') {
    if (!Array.isArray(params.todos) || typeof params.merge !== 'boolean') return noop;
    const todos = params.merge ? new Map(state.todos) : new Map<string, PlanEntry>();
    for (const value of params.todos) {
      const entry = planEntry(value);
      if (entry && record(value) && str(value.id)) todos.set(value.id as string, entry);
    }
    return { state: { ...state, todos }, events: [{ type: 'plan.updated', entries: [...todos.values()] }] };
  }
  if (message.method === 'cursor/task') {
    const id = str(params.toolCallId);
    if (!id || typeof params.description !== 'string') return noop;
    const prior = state.tools.get(id);
    // Cursor sends this after the regular tool completion, including failed tasks.
    // It is metadata for the task, never evidence of a child transcript or success.
    return tool({ toolCallId: id, kind: 'task', title: params.description, rawInput: params,
      status: prior?.status ?? 'completed' }, state, true);
  }
  if (message.method !== 'session/update' || !record(params.update)) return noop;
  const value = params.update;
  switch (value.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      if (!record(value.content) || value.content.type !== 'text' || typeof value.content.text !== 'string' || !value.content.text) return noop;
      const kind = value.sessionUpdate === 'agent_message_chunk' ? 'message' : 'reasoning';
      const delta = value.content.text;
      if (state.activeText?.kind === kind) {
        const item = { ...state.activeText, text: state.activeText.text + delta };
        return { state: { ...state, activeText: item }, events: [{ type: 'item.delta', itemId: item.id, field: kind === 'message' ? 'text' : 'reasoning', delta }] };
      }
      const closed = flush(state);
      const textSeq = state.textSeq + 1;
      const id = `cursor_text_${textSeq}`;
      const item: UiMessageItem | UiReasoningItem = kind === 'message' ? { kind, id, role: 'assistant', text: delta } : { kind, id, text: delta };
      return { state: { ...closed.state, textSeq, activeText: item }, events: [...closed.events, { type: 'item.started', item }] };
    }
    case 'tool_call':
    case 'tool_call_update': return tool(value, state);
    case 'plan': {
      if (!Array.isArray(value.entries)) return noop;
      const entries = value.entries.map(planEntry).filter((entry): entry is PlanEntry => entry !== undefined);
      return { state, events: [{ type: 'plan.updated', entries }] };
    }
    case 'usage_update': {
      // ACP reports context occupancy, NOT directional/per-turn token consumption.
      // Zero directional fields mean unavailable; never attach this to turn.completed.
      if (!count(value.used) || !count(value.size)) return noop;
      const cost = record(value.cost) && value.cost.currency === 'USD' && nonnegative(value.cost.amount) ? value.cost.amount : undefined;
      return { state, events: [{ type: 'usage.updated', usage: { input: 0, output: 0, total: value.used, contextWindow: value.size }, ...(cost !== undefined ? { costUsd: cost } : {}) }] };
    }
    default: return noop;
  }
}

function tool(value: Record<string, unknown>, state: CursorUiState, metadata = false): CursorUiMapping {
  const id = str(value.toolCallId);
  if (!id) return { state, events: [] };
  const closed = flush(state);
  const prior = state.tools.get(id);
  const kind = toolKind(value.kind) ?? prior?.toolKind ?? 'other';
  const status = toolStatus(value.status) ?? prior?.status ?? 'pending';
  const item: UiToolItem = { ...(prior ?? { kind: 'tool', id }), name: metadata ? 'task' : prior?.name ?? kind,
    toolKind: kind, title: str(value.title) ?? prior?.title ?? 'Tool', status };
  if (value.rawInput !== undefined && value.rawInput !== null) item.input = value.rawInput;
  if (value.rawOutput !== undefined && value.rawOutput !== null) item.output = serialize(value.rawOutput);
  if (Array.isArray(value.content)) {
    const output: string[] = [];
    const diffs: FileDiff[] = [];
    for (const part of value.content) {
      if (!record(part)) continue;
      if (part.type === 'content' && record(part.content) && part.content.type === 'text' && typeof part.content.text === 'string') output.push(part.content.text);
      if (part.type === 'diff' && typeof part.path === 'string' && (typeof part.oldText === 'string' || part.oldText === null || part.oldText === undefined) && typeof part.newText === 'string') {
        diffs.push({ path: part.path, oldText: part.oldText ?? null, newText: part.newText });
      }
    }
    // ACP content updates replace the previous content, including empty snapshots.
    if (output.length) item.output = output.join('\n');
    else if (value.rawOutput === undefined || value.rawOutput === null) delete item.output;
    item.diffs = diffs;
  }
  if (Array.isArray(value.locations)) {
    item.locations = value.locations.flatMap((location) => record(location) && typeof location.path === 'string'
      ? [{ path: location.path, ...(count(location.line) ? { line: location.line } : {}) }] : []);
  }
  if (status === 'failed' && item.output) item.error = item.output;
  const tools = new Map(closed.state.tools);
  tools.set(id, item);
  const events = [...closed.events];
  const terminal = status === 'completed' || status === 'failed' || status === 'declined';
  if (!prior) events.push({ type: 'item.started', item });
  if (prior || terminal) events.push({ type: metadata && prior ? 'item.updated' : terminal ? 'item.completed' : 'item.updated', item });
  return { state: { ...closed.state, tools }, events };
}
function planEntry(value: unknown): PlanEntry | undefined {
  if (!record(value) || typeof value.content !== 'string' || typeof value.status !== 'string' || !['pending', 'in_progress', 'completed', 'cancelled'].includes(value.status)) return undefined;
  return { content: value.content, status: value.status as PlanEntry['status'],
    ...(typeof value.priority === 'string' && ['high', 'medium', 'low'].includes(value.priority) ? { priority: value.priority as PlanEntry['priority'] } : {}) };
}
function toolKind(value: unknown): ToolKind | undefined {
  return typeof value === 'string' && ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'task', 'plan', 'other'].includes(value) ? value as ToolKind : undefined;
}
function toolStatus(value: unknown): ToolStatus | undefined {
  if (value === 'in_progress') return 'running';
  return typeof value === 'string' && ['pending', 'running', 'completed', 'failed', 'declined'].includes(value) ? value as ToolStatus : undefined;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function str(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function count(value: unknown): value is number { return nonnegative(value) && Number.isSafeInteger(value); }
function serialize(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return undefined; }
}
