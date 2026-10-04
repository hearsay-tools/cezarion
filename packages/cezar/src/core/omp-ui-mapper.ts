/**
 * Pure OMP (Oh My Pi) RPC → normalized protocol-v2 mapper (#595).
 *
 * Contract: oh-my-pi v18.4.11 `docs/rpc.md`, `packages/coding-agent/src/modes/rpc/rpc-types.ts`,
 * `rpc-subagents.ts` and `src/session/agent-session-events.ts`. OMP speaks Pi's RPC plus its
 * own extensions; where the two wires agree the logic below is copied from `pi-ui-mapper.ts`
 * (Pi stays untouched) and says so. What OMP changes:
 *
 * - the turn ends at `session_settled` (or a prompt OMP completed locally), never at `agent_end`,
 *   which also fires with `yielded: false` while OMP retries, compacts or answers a reminder;
 * - edit diffs and the todo plan come from the tool RESULT (`details`), not its args;
 * - sub-agents stream as `subagent_lifecycle` / `subagent_event` and nest under their `task` call.
 *
 * Unknown or malformed wire data is ignored; this mapper never throws.
 */
import type {
  FileDiff,
  PlanEntry,
  StopReason,
  TokenUsage,
  UiEvent,
  UiMessageItem,
  UiReasoningItem,
  UiToolItem,
} from './ui-events.js';
import { toolDisplay } from './tool-display.js';

/** One stream of text/reasoning blocks: the parent turn's, or one sub-agent's. */
interface OmpTextLane {
  readonly textBlock: number;
  readonly startedItems: ReadonlySet<string>;
  readonly endedItems: ReadonlySet<string>;
  readonly textByItem: ReadonlyMap<string, string>;
}

export interface OmpUiMapperState extends OmpTextLane {
  readonly sessionStarted: boolean;
  readonly sessionId: string | null;
  readonly turnSeq: number;
  readonly turnId: string | null;
  readonly stopReason: StopReason;
  /** Usage of the turn in flight, held from `message_end` to `session_settled` (as Pi's `turnUsage`). */
  readonly turnUsage: TokenUsage | null;
  readonly turnCostUsd: number | null;
  /**
   * Provider failure of the attempt in flight, released at `session_settled` or by
   * `ompFlushProviderError` on stream end, cleared by a later successful `message_end` —
   * OMP retries past provider flakes and a recovered retry must not surface (#256, #316).
   */
  readonly latchedProviderError: string | null;
  /** Every tool item by item id: parent calls by `toolCallId`, child calls `<rowId>/<toolCallId>`. */
  readonly tools: ReadonlyMap<string, UiToolItem>;
  /**
   * Sub-agent id → its dock row. `rowId` is the single-form `task` call itself, or the synthetic
   * `<toolCallId>#<id>` row of a batch call. `parentToolCallId` is empty when OMP sent none.
   */
  readonly subagents: ReadonlyMap<string, { rowId: string; parentToolCallId: string }>;
  /** `subagent_event` frames that arrived before their lifecycle frame named the parent. */
  readonly pendingSubagentEvents: ReadonlyMap<string, readonly unknown[]>;
  /** `task` calls in batch form (`args.tasks[]`): their card is not a dock row. */
  readonly batchCalls: ReadonlySet<string>;
  /** Text lanes of sub-agents, keyed by row id. */
  readonly childLanes: ReadonlyMap<string, OmpTextLane>;
  /** The one "events dropped" error for an overflowing early buffer has been emitted. */
  readonly subagentDropReported: boolean;
}

export interface OmpUiMapping {
  events: UiEvent[];
  state: OmpUiMapperState;
}

/** Early `subagent_event` buffer bounds (spec § Sub-agents and the Agents drawer). */
const PENDING_SUBAGENT_EVENTS_PER_ID = 200;
const PENDING_SUBAGENT_IDS = 8;
const SUBAGENT_DROP_MESSAGE = 'omp: sub-agent events dropped before lifecycle';

const EMPTY_LANE: OmpTextLane = {
  textBlock: 0,
  startedItems: new Set(),
  endedItems: new Set(),
  textByItem: new Map(),
};

export function createOmpUiState(): OmpUiMapperState {
  return {
    sessionStarted: false,
    sessionId: null,
    turnSeq: 0,
    turnId: null,
    stopReason: 'end_turn',
    turnUsage: null,
    turnCostUsd: null,
    latchedProviderError: null,
    ...EMPTY_LANE,
    tools: new Map(),
    subagents: new Map(),
    pendingSubagentEvents: new Map(),
    batchCalls: new Set(),
    childLanes: new Map(),
    subagentDropReported: false,
  };
}

/** Same as `pi-ui-mapper.ts` `piTurnStarted`. */
export function ompTurnStarted(state: OmpUiMapperState): OmpUiMapping {
  const turnSeq = state.turnSeq + 1;
  const turnId = `turn_${turnSeq}`;
  return {
    events: [{ type: 'turn.started', turnId }],
    state: { ...state, turnSeq, turnId, stopReason: 'end_turn', textBlock: 0 },
  };
}

/**
 * Which frame ends a turn (rpc.md § Yield vs settled): `session_settled` when the session went
 * quiet, or a prompt OMP finished without invoking the agent — a `prompt_result` with
 * `agentInvoked: false`, or the prompt's own success response carrying `data.agentInvoked:
 * false` (no `prompt_result` follows that one). `agent_end` is never a boundary.
 */
export function ompTurnBoundary(value: unknown): 'settled' | 'local' | null {
  if (!isRecord(value)) return null;
  if (value.type === 'session_settled') return 'settled';
  if (value.type === 'prompt_result' && value.agentInvoked === false) return 'local';
  if (
    value.type === 'response' &&
    value.command === 'prompt' &&
    value.success === true &&
    isRecord(value.data) &&
    value.data.agentInvoked === false
  ) {
    return 'local';
  }
  return null;
}

/** Same rule as `pi-ui-mapper.ts` `mapActivity`: activity after the turn ended re-opens one. */
function mapActivity(
  value: Record<string, unknown>,
  state: OmpUiMapperState,
  map: (value: Record<string, unknown>, state: OmpUiMapperState) => OmpUiMapping,
): OmpUiMapping {
  if (state.turnId) return map(value, state);
  const started = ompTurnStarted(state);
  const mapped = map(value, started.state);
  if (mapped.events.length === 0) return { events: [], state };
  return { events: [...started.events, ...mapped.events], state: mapped.state };
}

function isMessageUpdateActivity(value: Record<string, unknown>): boolean {
  const update = isRecord(value.assistantMessageEvent) ? value.assistantMessageEvent : undefined;
  const type = update ? string(update.type) : undefined;
  return type?.startsWith('text_') === true || type?.startsWith('thinking_') === true;
}

function isAssistantMessageEnd(value: Record<string, unknown>): boolean {
  return isRecord(value.message) && string(value.message.role) === 'assistant';
}

function isToolStart(value: Record<string, unknown>): boolean {
  return Boolean(string(value.toolCallId) && string(value.toolName));
}

export function mapOmpRpcMessage(value: unknown, state: OmpUiMapperState): OmpUiMapping {
  if (!isRecord(value) || typeof value.type !== 'string') return { events: [], state };

  if (value.type === 'response') return mapResponse(value, state);

  switch (value.type) {
    case 'message_update':
      return isMessageUpdateActivity(value)
        ? mapActivity(value, state, mapMessageUpdate)
        : mapMessageUpdate(value, state);
    case 'message_end':
      return isAssistantMessageEnd(value)
        ? mapActivity(value, state, mapMessageEnd)
        : mapMessageEnd(value, state);
    case 'tool_execution_start':
      return isToolStart(value) ? mapActivity(value, state, mapToolStart) : mapToolStart(value, state);
    case 'tool_execution_update':
      return mapActivity(value, state, mapToolUpdate);
    case 'tool_execution_end':
      return mapActivity(value, state, mapToolEnd);
    case 'session_settled':
      return completeTurn(state.stopReason, state);
    case 'prompt_result':
      return mapPromptResult(value, state);
    case 'subagent_lifecycle':
      return isRecord(value.payload) ? mapSubagentLifecycle(value.payload, state) : { events: [], state };
    case 'subagent_event':
      return isRecord(value.payload) ? mapSubagentEvent(value.payload, state) : { events: [], state };
    case 'extension_error': {
      const message = string(value.error) ?? string(value.message) ?? 'omp extension error';
      return { events: [{ type: 'session.error', message, fatal: false }], state };
    }
    case 'notice': {
      if (value.level !== 'error') return { events: [], state };
      const message = string(value.message) ?? 'omp error notice';
      return { events: [{ type: 'session.error', message, fatal: false }], state };
    }
    // `agent_end` (any `yielded`), `ready`, `queue_update`, `auto_*`, `cache_warming_*`, and the
    // unsolicited startup frames `extension_ui_request`, `advisor_cost_changed`,
    // `available_commands_update` (recorded from the real v18.4.11 binary) carry nothing here.
    default:
      return { events: [], state };
  }
}

function mapResponse(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const command = string(value.command);
  if (command === 'get_state' && value.success === true && isRecord(value.data)) {
    const sessionId = string(value.data.sessionId);
    if (sessionId && !state.sessionStarted) {
      const model = isRecord(value.data.model) ? string(value.data.model.id) : undefined;
      return {
        events: [{ type: 'session.started', sessionId, backend: 'omp', ...(model ? { model } : {}) }],
        state: { ...state, sessionStarted: true, sessionId },
      };
    }
    return { events: [], state };
  }
  if (command === 'prompt') {
    // A failed prompt is reported by its `prompt_result` (rpc.md § prompt payload), so the
    // legacy error response stays silent here rather than doubling the error.
    return ompTurnBoundary(value) === 'local' ? completeTurn(state.stopReason, state) : { events: [], state };
  }
  // `set_*` failures are configuration notes for the runner (v1), not session errors.
  if (value.success === false && !command?.startsWith('set_')) {
    return { events: [{ type: 'session.error', message: rpcError(value), fatal: false }], state };
  }
  return { events: [], state };
}

function mapPromptResult(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  // An agent-invoked prompt yields here, but the turn runs on until `session_settled`.
  if (ompTurnBoundary(value) !== 'local') return { events: [], state };
  const status = string(value.status);
  if (status === 'error') {
    const error = isRecord(value.error) ? value.error : {};
    const message = ompProviderErrorMessage({
      provider: error.provider,
      model: error.model,
      errorMessage: error.message,
    });
    const completed = completeTurn('error', state);
    return { events: [{ type: 'session.error', message, fatal: false }, ...completed.events], state: completed.state };
  }
  return completeTurn(status === 'aborted' ? 'cancelled' : state.stopReason, state);
}

/* ------------------------------------------------------------------ */
/* Text and reasoning — same wire as pi-ui-mapper.ts (rpc.md, v18.4.11) */
/* ------------------------------------------------------------------ */

/** Parent ids are `<turnId>_text_…`, child ids `<rowId>/text_…` (see `ItemScope`). */
const LANE_ITEM = /[_/](text|reasoning)_\d+_\d+$/;

function laneOf(state: OmpUiMapperState): OmpTextLane {
  return {
    textBlock: state.textBlock,
    startedItems: state.startedItems,
    endedItems: state.endedItems,
    textByItem: state.textByItem,
  };
}

function withChildLane(state: OmpUiMapperState, rowId: string, lane: OmpTextLane): OmpUiMapperState {
  const childLanes = new Map(state.childLanes);
  childLanes.set(rowId, lane);
  return { ...state, childLanes };
}

/** Item scope: the parent turn (`<turnId>_…`) or one sub-agent (`<rowId>/…`, nested under it). */
interface ItemScope {
  readonly textPrefix: string;
  readonly toolPrefix: string;
  readonly parentItemId?: string;
}

/** Same wire as pi-ui-mapper.ts `mapMessageUpdate` (rpc.md, v18.4.11), for one lane. */
function laneTextUpdate(
  update: Record<string, unknown>,
  lane: OmpTextLane,
  scope: ItemScope,
): { events: UiEvent[]; lane: OmpTextLane } {
  const updateType = string(update.type);
  const contentIndex = number(update.contentIndex) ?? 0;
  const field =
    updateType?.startsWith('thinking_') ? ('reasoning' as const) : updateType?.startsWith('text_') ? ('text' as const) : null;
  if (!updateType || !field) return { events: [], lane };

  const itemId = `${scope.textPrefix}${field}_${contentIndex}_${lane.textBlock}`;
  const events: UiEvent[] = [];
  let { startedItems, textByItem, endedItems } = lane;
  const makeItem = (text: string): UiMessageItem | UiReasoningItem =>
    withParent(
      field === 'text' ? { kind: 'message', id: itemId, role: 'assistant', text } : { kind: 'reasoning', id: itemId, text },
      scope,
    );

  const delta = string(update.delta);
  if (!startedItems.has(itemId)) {
    if (delta === undefined && !updateType.endsWith('_end')) return { events: [], lane };
    events.push({ type: 'item.started', item: makeItem('') });
    startedItems = new Set(startedItems).add(itemId);
  }

  if (delta !== undefined) {
    events.push({ type: 'item.delta', itemId, field, delta });
    const next = new Map(textByItem);
    next.set(itemId, `${next.get(itemId) ?? ''}${delta}`);
    textByItem = next;
  }

  if (updateType.endsWith('_end')) {
    const text = string(update.content) ?? textByItem.get(itemId) ?? '';
    events.push({ type: 'item.completed', item: makeItem(text) });
    endedItems = new Set(endedItems).add(itemId);
  }
  return { events, lane: { ...lane, startedItems, textByItem, endedItems } };
}

/** Same as pi-ui-mapper.ts `closeOpenPiText`, for one lane. */
function closeLaneText(lane: OmpTextLane, scope: ItemScope): { events: UiEvent[]; lane: OmpTextLane } {
  const events: UiEvent[] = [];
  let endedItems = lane.endedItems;
  for (const id of lane.startedItems) {
    if (endedItems.has(id)) continue;
    const kind = LANE_ITEM.exec(id)?.[1];
    if (!kind) continue;
    const text = lane.textByItem.get(id) ?? '';
    events.push({
      type: 'item.completed',
      item: withParent(
        kind === 'text' ? { kind: 'message', id, role: 'assistant', text } : { kind: 'reasoning', id, text },
        scope,
      ),
    });
    endedItems = new Set(endedItems).add(id);
  }
  return { events, lane: { ...lane, endedItems, textBlock: lane.textBlock + 1 } };
}

function parentScope(state: OmpUiMapperState): ItemScope {
  return { textPrefix: `${state.turnId ?? 'turn_0'}_`, toolPrefix: '' };
}

function childScope(rowId: string): ItemScope {
  return { textPrefix: `${rowId}/`, toolPrefix: `${rowId}/`, parentItemId: rowId };
}

function withParent<T extends UiMessageItem | UiReasoningItem | UiToolItem>(item: T, scope: ItemScope): T {
  return scope.parentItemId === undefined ? item : { ...item, parentItemId: scope.parentItemId };
}

function closeParentText(state: OmpUiMapperState): OmpUiMapping {
  const closed = closeLaneText(laneOf(state), parentScope(state));
  return { events: closed.events, state: { ...state, ...closed.lane } };
}

/** Same wire as pi-ui-mapper.ts `mapMessageUpdate` (rpc.md, v18.4.11). */
function mapMessageUpdate(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const update = isRecord(value.assistantMessageEvent) ? value.assistantMessageEvent : undefined;
  const updateType = update ? string(update.type) : undefined;
  if (!update || !updateType || !state.turnId) return { events: [], state };

  if (updateType === 'done') {
    return { events: [], state: { ...state, stopReason: mapOmpMessageStopReason(string(update.reason)) } };
  }
  if (updateType === 'error') {
    const reason: StopReason = string(update.reason) === 'aborted' ? 'cancelled' : 'error';
    const error = isRecord(update.error) ? string(update.error.errorMessage) : undefined;
    return {
      events: [],
      state: { ...state, stopReason: reason, latchedProviderError: error ?? `omp model ${reason}` },
    };
  }
  const mapped = laneTextUpdate(update, laneOf(state), parentScope(state));
  return { events: mapped.events, state: { ...state, ...mapped.lane } };
}

/** Same wire as pi-ui-mapper.ts `mapMessageEnd` (rpc.md, v18.4.11). */
function mapMessageEnd(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const message = isRecord(value.message) ? value.message : undefined;
  if (!message || string(message.role) !== 'assistant') return { events: [], state };
  const closed = closeParentText(state);
  state = closed.state;
  const events = [...closed.events];
  const usage = usageEvent(message.usage);
  if (usage) {
    events.push(usage);
    state = { ...state, turnUsage: usage.usage, turnCostUsd: usage.costUsd ?? null };
  }
  // Latch the failed attempt, clear on a successful one (#316): `agent_end {yielded:false}`
  // follows a failed attempt OMP is about to retry, and a recovered retry must stay silent.
  if (string(message.stopReason) === 'error') {
    state = { ...state, latchedProviderError: ompProviderErrorMessage(message) };
  } else {
    state = { ...state, latchedProviderError: null };
  }
  state = { ...state, stopReason: mapOmpMessageStopReason(string(message.stopReason)) };
  return { events, state };
}

/** Same as pi-ui-mapper.ts `mapPiMessageStopReason`. */
function mapOmpMessageStopReason(reason: string | undefined): StopReason {
  if (reason === 'error') return 'error';
  if (reason === 'aborted') return 'cancelled';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */

/** `toolDisplay` plus the OMP-only shapes: `todo` is the plan tool and a batch `task` is a plain card. */
function ompToolDisplay(name: string, args: unknown): { toolKind: UiToolItem['toolKind']; title: string } {
  if (name === 'todo') return { toolKind: 'plan', title: 'Update plan' };
  if (name === 'task' && isRecord(args) && Array.isArray(args.tasks)) {
    // The drawer lists one synthetic row per sub-agent; the card itself must not be a row too.
    return { toolKind: 'other', title: `Task batch · ${args.tasks.length} agents` };
  }
  // The single form has no `description`; its `task` text is the row's label.
  const display =
    name === 'task' && isRecord(args) && args.description === undefined
      ? toolDisplay(name, { description: args.task })
      : toolDisplay(name, args);
  return { toolKind: display.toolKind, title: display.title };
}

function mapToolStart(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const callId = string(value.toolCallId);
  const name = string(value.toolName);
  if (!callId || !name) return { events: [], state };
  const closed = closeParentText(state);
  state = closed.state;
  const started = toolStarted(callId, name, value.args, parentScope(state), state);
  let batchCalls = state.batchCalls;
  if (name === 'task' && isRecord(value.args) && Array.isArray(value.args.tasks)) {
    batchCalls = new Set(batchCalls).add(callId);
  }
  return { events: [...closed.events, ...started.events], state: { ...started.state, batchCalls } };
}

function toolStarted(
  callId: string,
  name: string,
  args: unknown,
  scope: ItemScope,
  state: OmpUiMapperState,
): OmpUiMapping {
  const display = ompToolDisplay(name, args);
  const item = withParent<UiToolItem>(
    {
      kind: 'tool',
      id: `${scope.toolPrefix}${callId}`,
      name,
      toolKind: display.toolKind,
      title: display.title,
      status: 'running',
      input: args,
    },
    scope,
  );
  const tools = new Map(state.tools);
  tools.set(item.id, item);
  return { events: [{ type: 'item.started', item }], state: { ...state, tools } };
}

function mapToolUpdate(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  return toolUpdated(value, '', state);
}

function toolUpdated(value: Record<string, unknown>, toolPrefix: string, state: OmpUiMapperState): OmpUiMapping {
  const callId = string(value.toolCallId);
  const id = callId ? `${toolPrefix}${callId}` : undefined;
  const previous = id ? state.tools.get(id) : undefined;
  if (!id || !previous) return { events: [], state };
  const output = contentText(isRecord(value.partialResult) ? value.partialResult.content : undefined);
  if (output === undefined) return { events: [], state };
  const item: UiToolItem = { ...previous, output };
  const tools = new Map(state.tools);
  tools.set(id, item);
  return { events: [{ type: 'item.updated', item }], state: { ...state, tools } };
}

function mapToolEnd(value: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  return toolEnded(value, parentScope(state), state, true);
}

function toolEnded(
  value: Record<string, unknown>,
  scope: ItemScope,
  state: OmpUiMapperState,
  publishPlan: boolean,
): OmpUiMapping {
  const callId = string(value.toolCallId);
  const id = callId ? `${scope.toolPrefix}${callId}` : undefined;
  const previous = id ? state.tools.get(id) : undefined;
  if (!id || !previous) return { events: [], state };
  const result = isRecord(value.result) ? value.result : {};
  const output = contentText(result.content);
  const isError = value.isError === true || result.isError === true;
  const item: UiToolItem = {
    ...previous,
    status: isError ? 'failed' : 'completed',
    ...(isError ? { error: output ?? 'omp tool failed' } : output !== undefined ? { output } : {}),
  };
  const diffs = isError ? undefined : ompToolDiffs(previous.name, previous.input, result);
  if (diffs) {
    item.diffs = diffs;
    // Hashline edits carry the path only in `{input}` text; the result names it.
    if (item.title === 'Edit') item.title = diffs.length === 1 ? `Edit ${diffs[0]!.path}` : `Edit ${diffs.length} files`;
  }
  const tools = new Map(state.tools);
  tools.set(id, item);
  const events: UiEvent[] = [{ type: 'item.completed', item }];
  // A sub-agent's todo list is its own; it never replaces the session's plan dock.
  const plan = publishPlan && !isError ? ompToolPlan(previous.name, result) : undefined;
  if (plan) events.push({ type: 'plan.updated', entries: plan });
  return { events, state: { ...state, tools } };
}

/**
 * Diffs for an `edit`/`write` call. OMP's default `edit.mode` is `hashline` (args `{input}`), so
 * the change lives in the result `details` (`path`/`oldText`/`newText`, or `perFileResults[]` for
 * several files — `src/edit/index.ts` `aggregateDetails`, v18.4.11). Falls back to replace-mode
 * args and `write` content, the same reading as pi-ui-mapper.ts `toolDiffs`.
 */
function ompToolDiffs(name: string, args: unknown, result: Record<string, unknown>): FileDiff[] | undefined {
  const key = name.toLowerCase();
  if (key !== 'edit' && key !== 'write') return undefined;
  const details = isRecord(result.details) ? result.details : undefined;
  if (details) {
    const files = Array.isArray(details.perFileResults) ? details.perFileResults : [details];
    const diffs = files.flatMap((file) => {
      const diff = isRecord(file) ? detailDiff(file) : undefined;
      return diff ? [diff] : [];
    });
    if (diffs.length > 0) return diffs;
  }
  return argsDiffs(key, args);
}

function detailDiff(file: Record<string, unknown>): FileDiff | undefined {
  const path = string(file.path);
  const oldText = string(file.oldText);
  const newText = string(file.newText);
  if (!path || (oldText === undefined && newText === undefined)) return undefined;
  return { path, oldText: oldText ?? null, ...(newText !== undefined ? { newText } : {}) };
}

/** Same reading as pi-ui-mapper.ts `toolDiffs`. */
function argsDiffs(key: string, input: unknown): FileDiff[] | undefined {
  if (!isRecord(input)) return undefined;
  const path = string(input.path) ?? string(input.file_path) ?? string(input.filePath);
  if (!path) return undefined;
  const oldText = string(input.oldText) ?? string(input.old_string) ?? (key === 'write' ? null : undefined);
  const newText = string(input.newText) ?? string(input.new_string) ?? string(input.content);
  if (oldText === undefined && newText === undefined) return undefined;
  return [{ path, oldText: oldText ?? null, ...(newText !== undefined ? { newText } : {}) }];
}

const TODO_STATUS: Readonly<Record<string, PlanEntry['status']>> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  abandoned: 'cancelled',
  // A blocked task is still to do; the plan vocabulary has no "blocked".
  blocked: 'pending',
};

/**
 * The whole plan from a state-changing `todo` result: `details.phases[].tasks[]` holds the full
 * list after the op (`src/tools/todo.ts` `committedTodoPhases`, v18.4.11). `view` is a read.
 */
function ompToolPlan(name: string, result: Record<string, unknown>): PlanEntry[] | undefined {
  if (name !== 'todo' || !isRecord(result.details)) return undefined;
  const { op, phases } = result.details;
  if (op === 'view' || !Array.isArray(phases)) return undefined;
  const entries: PlanEntry[] = [];
  for (const phase of phases) {
    if (!isRecord(phase) || !Array.isArray(phase.tasks)) continue;
    for (const task of phase.tasks) {
      if (!isRecord(task)) continue;
      const content = string(task.content);
      const status = TODO_STATUS[string(task.status) ?? ''];
      if (content && status) entries.push({ content, status });
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Sub-agents                                                           */
/* ------------------------------------------------------------------ */

function lifecycleStatus(status: string | undefined): UiToolItem['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'aborted') return 'failed';
  return 'running';
}

/** The batch entry this sub-agent runs: by `name` (OMP derives the id from it), else by index. */
function batchTask(parent: UiToolItem | undefined, id: string, index: number | undefined): Record<string, unknown> | undefined {
  const tasks = isRecord(parent?.input) && Array.isArray(parent.input.tasks) ? parent.input.tasks : [];
  const byName = tasks.find((task) => isRecord(task) && string(task.name) === id);
  if (isRecord(byName)) return byName;
  const byIndex = index !== undefined ? tasks[index] : undefined;
  return isRecord(byIndex) ? byIndex : undefined;
}

function mapSubagentLifecycle(payload: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const id = string(payload.id);
  if (!id) return { events: [], state };
  const status = lifecycleStatus(string(payload.status));
  const events: UiEvent[] = [];
  let entry = state.subagents.get(id);

  if (!entry) {
    const parentToolCallId = string(payload.parentToolCallId) ?? '';
    const parent = parentToolCallId ? state.tools.get(parentToolCallId) : undefined;
    // A single-form call IS the sub-agent's row; a batch call (or an unknown parent) gets one
    // synthetic `task` row per sub-agent so the drawer counts agents, not calls.
    const single = parent !== undefined && !state.batchCalls.has(parentToolCallId);
    const rowId = single ? parentToolCallId : `${parentToolCallId || 'omp-subagent'}#${id}`;
    entry = { rowId, parentToolCallId };
    const subagents = new Map(state.subagents);
    subagents.set(id, entry);
    state = { ...state, subagents };
    if (!single) {
      const agent = string(payload.agent);
      const task = batchTask(parent, id, number(payload.index));
      const taskText = task ? string(task.task) : undefined;
      const label = string(payload.description) ?? taskText ?? agent ?? id;
      const item: UiToolItem = {
        kind: 'tool',
        id: rowId,
        name: 'task',
        toolKind: 'task',
        title: toolDisplay('task', { description: label }).title,
        status: 'running',
        input: { ...(agent ? { agent } : {}), ...(taskText ? { task: taskText } : {}) },
      };
      const tools = new Map(state.tools);
      tools.set(rowId, item);
      state = { ...state, tools };
      events.push({ type: 'item.started', item });
    }
  }

  // Replay what arrived before this frame named the parent, ahead of any terminal close.
  const buffered = state.pendingSubagentEvents.get(id);
  if (buffered) {
    const pendingSubagentEvents = new Map(state.pendingSubagentEvents);
    pendingSubagentEvents.delete(id);
    state = { ...state, pendingSubagentEvents };
    for (const event of buffered) {
      const mapped = mapChildEvent(event, entry.rowId, state);
      state = mapped.state;
      events.push(...mapped.events);
    }
  }

  if (status !== 'running') {
    // An aborted agent leaves its last block open; it ends with the agent, not the turn.
    const lane = state.childLanes.get(entry.rowId);
    if (lane) {
      const closed = closeLaneText(lane, childScope(entry.rowId));
      events.push(...closed.events);
      state = withChildLane(state, entry.rowId, closed.lane);
    }
  }

  const row = entry.rowId !== entry.parentToolCallId ? state.tools.get(entry.rowId) : undefined;
  if (row && row.status !== status) {
    const item: UiToolItem = { ...row, status };
    const tools = new Map(state.tools);
    tools.set(row.id, item);
    state = { ...state, tools };
    events.push({ type: status === 'running' ? 'item.updated' : 'item.completed', item });
  }
  return { events, state };
}

function mapSubagentEvent(payload: Record<string, unknown>, state: OmpUiMapperState): OmpUiMapping {
  const id = string(payload.id);
  if (!id || !isRecord(payload.event)) return { events: [], state };
  const entry = state.subagents.get(id);
  if (entry) return mapChildEvent(payload.event, entry.rowId, state);

  // Only the lifecycle frame names the parent call: hold the event until it arrives.
  const buffered = state.pendingSubagentEvents.get(id);
  const full = buffered
    ? buffered.length >= PENDING_SUBAGENT_EVENTS_PER_ID
    : state.pendingSubagentEvents.size >= PENDING_SUBAGENT_IDS;
  if (full) {
    if (state.subagentDropReported) return { events: [], state };
    return {
      events: [{ type: 'session.error', message: SUBAGENT_DROP_MESSAGE, fatal: false }],
      state: { ...state, subagentDropReported: true },
    };
  }
  const pendingSubagentEvents = new Map(state.pendingSubagentEvents);
  pendingSubagentEvents.set(id, [...(buffered ?? []), payload.event]);
  return { events: [], state: { ...state, pendingSubagentEvents } };
}

/**
 * One sub-agent's `AgentSessionEvent`, nested under its row. It never ends the parent turn,
 * never writes parent text, never moves the session's usage or plan: a child `agent_end` only
 * closes the child's own open text.
 */
function mapChildEvent(event: unknown, rowId: string, state: OmpUiMapperState): OmpUiMapping {
  if (!isRecord(event) || typeof event.type !== 'string') return { events: [], state };
  const scope = childScope(rowId);
  const lane = state.childLanes.get(rowId) ?? EMPTY_LANE;
  switch (event.type) {
    case 'message_update': {
      if (!isRecord(event.assistantMessageEvent)) return { events: [], state };
      const mapped = laneTextUpdate(event.assistantMessageEvent, lane, scope);
      return { events: mapped.events, state: withChildLane(state, rowId, mapped.lane) };
    }
    case 'message_end':
    case 'agent_end': {
      if (event.type === 'message_end' && !isAssistantMessageEnd(event)) return { events: [], state };
      const closed = closeLaneText(lane, scope);
      return { events: closed.events, state: withChildLane(state, rowId, closed.lane) };
    }
    case 'tool_execution_start': {
      const callId = string(event.toolCallId);
      const name = string(event.toolName);
      if (!callId || !name) return { events: [], state };
      const closed = closeLaneText(lane, scope);
      const started = toolStarted(callId, name, event.args, scope, withChildLane(state, rowId, closed.lane));
      return { events: [...closed.events, ...started.events], state: started.state };
    }
    case 'tool_execution_update':
      return toolUpdated(event, scope.toolPrefix, state);
    case 'tool_execution_end':
      return toolEnded(event, scope, state, false);
    default:
      return { events: [], state };
  }
}

/* ------------------------------------------------------------------ */
/* Turn end, usage and errors                                           */
/* ------------------------------------------------------------------ */

/** Same as pi-ui-mapper.ts `completeTurn`, also closing every sub-agent's open text. */
function completeTurn(reason: StopReason, state: OmpUiMapperState): OmpUiMapping {
  if (!state.turnId) return { events: [], state };
  const turnId = state.turnId;
  const closed = closeParentText(state);
  state = closed.state;
  const events = [...closed.events];
  for (const [rowId, lane] of state.childLanes) {
    const child = closeLaneText(lane, childScope(rowId));
    events.push(...child.events);
    state = withChildLane(state, rowId, child.lane);
  }
  const flushed = ompFlushProviderError(state);
  state = flushed.state;
  const event: Extract<UiEvent, { type: 'turn.completed' }> = { type: 'turn.completed', turnId, stopReason: reason };
  if (state.turnUsage) event.usage = state.turnUsage;
  if (state.turnCostUsd !== null) event.costUsd = state.turnCostUsd;
  return {
    events: [...events, ...flushed.events, event],
    state: { ...state, turnId: null, turnUsage: null, turnCostUsd: null },
  };
}

/** Same as pi-ui-mapper.ts `piFlushProviderError`: release the latch as `session.error` (#256). */
export function ompFlushProviderError(state: OmpUiMapperState): OmpUiMapping {
  if (!state.latchedProviderError) return { events: [], state };
  return {
    events: [{ type: 'session.error', message: state.latchedProviderError, fatal: false }],
    state: { ...state, latchedProviderError: null },
  };
}

/** Same as pi-ui-mapper.ts `piProviderErrorMessage`, prefixed `omp:`. */
export function ompProviderErrorMessage(message: Record<string, unknown>): string {
  const detail = ompProviderErrorDetail(message);
  const provider = string(message.provider);
  const model = string(message.model);
  const who = provider && model ? `${provider}/${model}` : (provider ?? model);
  if (who && detail) return `omp: ${who} request failed: ${detail}`;
  if (who) return `omp: ${who} request failed`;
  if (detail) return `omp: provider request failed: ${detail}`;
  return 'omp: provider request failed';
}

/** Same as pi-ui-mapper.ts `piProviderErrorDetail`. */
function ompProviderErrorDetail(message: Record<string, unknown>): string | undefined {
  if (Array.isArray(message.diagnostics)) {
    for (const diagnostic of message.diagnostics) {
      if (!isRecord(diagnostic) || string(diagnostic.type) !== 'provider_transport_failure') continue;
      const error = isRecord(diagnostic.error) ? string(diagnostic.error.message) : undefined;
      if (error) return error;
    }
  }
  return string(message.errorMessage);
}

/** Same as pi-ui-mapper.ts `usageEvent`. */
function usageEvent(value: unknown): Extract<UiEvent, { type: 'usage.updated' }> | undefined {
  if (!isRecord(value)) return undefined;
  const input = number(value.input) ?? 0;
  const output = number(value.output) ?? 0;
  const cacheRead = number(value.cacheRead);
  const cacheWrite = number(value.cacheWrite);
  const total = number(value.totalTokens) ?? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (total <= 0) return undefined;
  const cost = isRecord(value.cost) ? number(value.cost.total) : undefined;
  return {
    type: 'usage.updated',
    usage: {
      input,
      output,
      total,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}

/** OMP's failure response carries `error` as a string (rpc.md § Responses). */
function rpcError(value: Record<string, unknown>): string {
  if (typeof value.error === 'string') return value.error;
  const error = isRecord(value.error) ? value.error : undefined;
  return string(error?.message) ?? string(value.message) ?? `omp RPC command ${string(value.command) ?? 'unknown'} failed`;
}

/** Same as pi-ui-mapper.ts `contentText`. */
function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((part) => (isRecord(part) && part.type === 'text' ? string(part.text) : undefined))
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
