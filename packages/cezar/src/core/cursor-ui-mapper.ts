/** Pure ACP notification mapper. Transport and asks belong to the runner; session attribution stays here.
 * Wire sources and vendor limitations: __fixtures__/cursor/README.md.
 */
import type { FileDiff, PlanEntry, StopReason, ToolKind, ToolStatus, UiEvent, UiMessageItem, UiReasoningItem, UiToolItem } from './ui-events.js';

export interface CursorUiState {
  readonly sessionId?: string;
  readonly childSessions: ReadonlyMap<string, CursorChildSession>;
  readonly turnSeq: number;
  readonly turnId?: string;
  readonly textSeq: number;
  readonly activeText?: UiMessageItem | UiReasoningItem;
  readonly tools: ReadonlyMap<string, UiToolItem>;
  readonly todos: ReadonlyMap<string, PlanEntry>;
}
export interface CursorChildSession {
  readonly parentSessionId: string;
  readonly parentItemId: string;
  readonly toolCallId: string;
  readonly terminal: boolean;
  readonly state: CursorUiState;
}
export interface CursorUiMapping { state: CursorUiState; events: UiEvent[] }
export function createCursorUiState(): CursorUiState {
  return { turnSeq: 0, textSeq: 0, tools: new Map(), todos: new Map(), childSessions: new Map() };
}
export function cursorTurnStarted(state: CursorUiState): CursorUiMapping {
  const closed = flushAll(state);
  const turnSeq = state.turnSeq + 1;
  const turnId = `turn_${turnSeq}`;
  return { state: { ...closed.state, turnSeq, turnId }, events: [...closed.events, { type: 'turn.started', turnId }] };
}
export function cursorTurnCompleted(reason: string, state: CursorUiState): CursorUiMapping {
  if (!state.turnId) return { state, events: [] };
  const closed = flushAll(state);
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

/** Child ids are namespaced because ACP tool ids are session-local. */
function childItemId(sessionId: string, itemId: string): string {
  return `cursor_child_${JSON.stringify([sessionId, itemId])}`;
}
function childEvents(events: UiEvent[], sessionId: string, parentItemId: string): UiEvent[] {
  return events.flatMap((event): UiEvent[] => {
    switch (event.type) {
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return [{ ...event, item: { ...event.item, id: childItemId(sessionId, event.item.id), parentItemId } }];
      case 'item.delta': return [{ ...event, itemId: childItemId(sessionId, event.itemId) }];
      // Child plans/usage must not replace the parent session's global panels.
      default: return [];
    }
  });
}
function flushAll(state: CursorUiState): CursorUiMapping {
  const closed = flush(state);
  const childSessions = new Map(state.childSessions);
  const events = [...closed.events];
  for (const [sessionId, child] of childSessions) {
    const mapped = flush(child.state);
    events.push(...childEvents(mapped.events, sessionId, child.parentItemId));
    childSessions.set(sessionId, { ...child, state: mapped.state, terminal: true });
  }
  return { state: { ...closed.state, childSessions }, events };
}

export function mapCursorMessage(message: unknown, state: CursorUiState): CursorUiMapping {
  const noop: CursorUiMapping = { state, events: [] };
  if (!record(message) || !record(message.params)) return noop;
  if (message.method !== 'session/update') {
    // Cursor extensions omit sessionId, including those sent by child presenters.
    // Attribute their tool id before touching any session-wide panel.
    const toolId = str(message.params.toolCallId);
    const children = toolId ? [...state.childSessions].filter(([, child]) => child.state.tools.has(toolId)) : [];
    if (children.length > 1 || (children.length && toolId && state.tools.has(toolId))) return noop;
    const owner = children[0];
    if (owner) {
      const [sessionId, child] = owner;
      const mapped = mapSessionMessage(message, child.state);
      const childSessions = new Map(state.childSessions);
      childSessions.set(sessionId, { ...child, state: mapped.state });
      return { state: { ...state, childSessions }, events: childEvents(mapped.events, sessionId, child.parentItemId) };
    }
    if ((!toolId || !state.tools.has(toolId)) && [...state.childSessions.values()].some(child => !child.terminal)) return noop;
    return mapSessionMessage(message, state);
  }
  const { sessionId, update } = message.params;
  if (!str(sessionId) || !record(update)) return noop;
  const sourceId = sessionId as string;
  const sourceChild = state.childSessions.get(sourceId);
  if (sourceId !== state.sessionId && (!sourceChild || sourceChild.terminal)) return noop;
  const source = sourceChild?.state ?? state;
  const commitSource = (mapped: CursorUiMapping): CursorUiMapping => {
    if (!sourceChild) return mapped;
    const childSessions = new Map(state.childSessions);
    childSessions.set(sourceId, { ...sourceChild, state: mapped.state });
    return { state: { ...state, childSessions }, events: childEvents(mapped.events, sourceId, sourceChild.parentItemId) };
  };

  if (update.sessionUpdate === 'subagent_spawned') {
    const childId = str(update.subagentSessionId);
    const cursor = record(update._meta) && record(update._meta.cursor) ? update._meta.cursor : undefined;
    const toolCallId = str(cursor?.toolCallId);
    if (!childId || !toolCallId || childId === state.sessionId || state.childSessions.has(childId)) return noop;
    const mapped = commitSource(tool({ toolCallId, kind: 'task', title: str(update.name) ?? 'Task',
      status: 'in_progress', rawInput: { task: update.task } }, source));
    const childSessions = new Map(mapped.state.childSessions);
    childSessions.set(childId, {
      parentSessionId: sourceId,
      parentItemId: sourceChild ? childItemId(sourceId, toolCallId) : toolCallId,
      toolCallId, terminal: false, state: { ...createCursorUiState(), sessionId: childId },
    });
    return { state: { ...mapped.state, childSessions }, events: mapped.events };
  }
  if (update.sessionUpdate === 'subagent_state_update') {
    const childId = str(update.subagentSessionId);
    const child = childId ? state.childSessions.get(childId) : undefined;
    if (!childId || !child || child.terminal || child.parentSessionId !== sourceId ||
      typeof update.state !== 'string' || !['completed', 'failed', 'cancelled', 'disconnected'].includes(update.state)) return noop;
    const closed = flush(child.state);
    const mapped = commitSource(tool({ toolCallId: child.toolCallId, kind: 'task',
      status: update.state === 'completed' ? 'completed' : 'failed' }, source));
    const childSessions = new Map(mapped.state.childSessions);
    childSessions.set(childId, { ...child, state: closed.state, terminal: true });
    return { state: { ...mapped.state, childSessions },
      events: [...childEvents(closed.events, childId, child.parentItemId), ...mapped.events] };
  }
  const mapped = mapSessionMessage(message, source);
  if (mapped.state === source && mapped.events.length === 0) return noop;
  return commitSource(mapped);
}

function mapSessionMessage(message: unknown, state: CursorUiState): CursorUiMapping {
  const noop = { state, events: [] };
  if (!record(message) || !record(message.params)) return noop;
  const params = message.params;
  if (message.method === 'cursor/update_todos') {
    if (!Array.isArray(params.todos) || typeof params.merge !== 'boolean') return noop;
    const todos = params.merge ? new Map(state.todos) : new Map<string, PlanEntry>();
    for (const value of params.todos) {
      const entry = planEntry(value);
      if (!entry || !record(value) || !str(value.id)) return noop;
      todos.set(value.id as string, entry);
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
      const entries: PlanEntry[] = [];
      for (const raw of value.entries) {
        const entry = planEntry(raw);
        if (!entry) return noop;
        entries.push(entry);
      }
      return { state, events: [{ type: 'plan.updated', entries }] };
    }
    case 'usage_update':
      // ACP used/size reports context occupancy, not cumulative consumption.
      // UiEvent has no occupancy-only event; do not invent directional tokens
      // or mislabel a context snapshot as cumulative session usage.
      return noop;
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
