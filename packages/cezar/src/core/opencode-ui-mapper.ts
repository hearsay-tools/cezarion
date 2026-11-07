import { opencodeSkillWarning } from './opencode-session-error.ts';
/**
 * Pure opencode SSE-bus → protocol-v2 mapper. `mapOpencodeEvent` folds one
 * parsed `{type, properties}` bus event into `UiEvent`s plus the next mapper
 * state; the runner calls it ALONGSIDE the v1 path (v1 events keep flowing
 * unchanged — including v1's HTTP-response-synthesized `turn-end`; only the
 * v2 stream uses the correct `session.idle` signal, fixing gap §5.9).
 *
 * Contract: `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` §4
 * (wire format: Message/Part model, ToolState lifecycle) and §7.1
 * "OpenCode (SSE)" (the mapping). Golden fixtures replaying wire-faithful
 * bus-event sequences live in `__fixtures__/opencode/`.
 *
 * Robustness rule: input is untrusted wire data — the mapper never throws;
 * unknown event/part types map to zero events.
 *
 * State is explicit and treated as immutable: callers thread the returned
 * `state` into the next call. Ids are deterministic — items reuse the wire
 * part ids, turns get `turn_<n>` minted at each prompt POST — so replaying
 * a stored transcript reproduces the exact event sequence.
 *
 * Opencode-specific mechanics baked in:
 *  - text/reasoning parts carry the FULL accumulated text on every update;
 *    a per-part cursor diffs it into true `item.delta`s (a server-provided
 *    `delta` field wins when present — newer servers send it);
 *  - tool parts have the ONLY real `pending` phase of the three backends
 *    (`pending→pending`, `running→running`, `completed→completed`,
 *    `error→failed`);
 *  - the SSE bus is server-wide: parts from a foreign session id are a
 *    subtask's child session and nest via `parentItemId` (§7.1). A `subtask`
 *    part or a top-level `task` tool call opens a scope: the task tool names
 *    its child (`metadata.sessionId`) and binds to it outright, while a
 *    scope with no wire link queues and child sessions claim queued scopes
 *    first-in-first-out as they are heard from (#5). Closed children are
 *    tombstoned for the mapper's lifetime; anything foreign outside a
 *    subtask scope is dropped.
 */

import type {
  FileDiff,
  PlanEntry,
  PlanStatus,
  ToolLocation,
  ToolStatus,
  UiEvent,
  UiMessageItem,
  UiReasoningItem,
  UiToolItem,
} from './ui-events.ts';
import { toolDisplay } from '@open-mercato/cezar-contract/tool-display';
import { EMPTY_MESSAGE_USAGE, addUsage, emitUsage, maxCost, tokensToUsage, usageForMessages } from './opencode-usage.ts';
import type { MessageUsage } from './opencode-usage.ts';
import type { OpencodeUiMapperState, OpencodeUiMapping, SubtaskScope } from './opencode-ui-mapper-state.ts';

export type { OpencodeUiMapperState, OpencodeUiMapping } from './opencode-ui-mapper-state.ts';

export function createOpencodeUiState(): OpencodeUiMapperState {
  return {
    sessionId: null,
    sessionStarted: false,
    turnSeq: 0,
    currentTurnId: null,
    currentTurnMessageIds: new Set(),
    turnErrored: false,
    msgRoles: new Map(),
    cursors: new Map(),
    startedItems: new Set(),
    endedItems: new Set(),
    tools: new Map(),
    lastPlanJson: null,
    subtasks: new Map(),
    unboundSubtasks: [],
    closedSessions: new Set(),
    usageByMessage: new Map(),
    lastUsage: null,
  };
}

/**
 * Opencode has no wire-level session-start event — the session is created by
 * the runner's `POST /session`, so the runner calls this once the response
 * carries the id (like codex's out-of-band thread/start result).
 */
export function opencodeSessionStarted(
  sessionId: string,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  if (state.sessionStarted || sessionId === '') return { events: [], state };
  return {
    events: [{ type: 'session.started', sessionId, backend: 'opencode' }],
    state: { ...state, sessionId, sessionStarted: true },
  };
}

/**
 * Opencode has no wire-level turn-start either — the runner POSTing a prompt
 * IS the turn boundary, so the runner calls this on each prompt POST. The
 * matching `turn.completed` comes from the wire `session.idle` (never from
 * the HTTP prompt response — that is v1's known fidelity gap).
 */
export function opencodeTurnStarted(state: OpencodeUiMapperState): OpencodeUiMapping {
  const turnId = `turn_${state.turnSeq + 1}`;
  return {
    events: [{ type: 'turn.started', turnId }],
    state: {
      ...state,
      turnSeq: state.turnSeq + 1,
      currentTurnId: turnId,
      currentTurnMessageIds: new Set(),
      turnErrored: false,
    },
  };
}

/** Fold one parsed SSE bus event into v2 events. Never throws. */
export function mapOpencodeEvent(evt: unknown, state: OpencodeUiMapperState): OpencodeUiMapping {
  if (!isRecord(evt) || typeof evt.type !== 'string') return { events: [], state };
  const props = isRecord(evt.properties) ? evt.properties : {};
  switch (evt.type) {
    case 'message.updated':
    case 'message.created':
    case 'message.completed':
      return mapMessageInfo(props, state);
    case 'message.part.updated':
    case 'message.part.created':
      return mapPart(props, state);
    case 'session.idle':
      return mapIdle(props, state);
    case 'session.error':
      return mapSessionError(props, state);
    default:
      // server.connected, session.updated, message.part.removed,
      // permission.* (the runner answers or bridges those; it owns the reply), …
      return { events: [], state };
  }
}

// ---- message info → roles + usage.updated -----------------------------------

function mapMessageInfo(props: Record<string, unknown>, state: OpencodeUiMapperState): OpencodeUiMapping {
  const info = isRecord(props.info) ? props.info : props;
  const id = str(info.id);
  const role = str(info.role);
  let next = resolveForeignMessage(str(info.sessionID), state);
  next = withMessageRole(next, id, role);
  next = withTurnMessage(next, id, role);
  // Telemetry rides only on assistant messages (cumulative per message).
  if (id !== undefined && role === 'assistant') {
    return mergeMessageUsage(next, id, info);
  }
  return { events: [], state: next };
}

/** A message whose session id is not ours belongs to a subtask's child
 *  session; hearing from it binds the oldest pending scope. */
function resolveForeignMessage(
  messageSession: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapperState {
  const foreign = messageSession !== undefined && state.sessionId !== null && messageSession !== state.sessionId;
  return foreign && messageSession !== undefined ? resolveSubtask(messageSession, state).state : state;
}

/** Remember a message's role when it changed — parts carry no role, so this
 *  map is the only way later parts know whose they are. */
function withMessageRole(
  state: OpencodeUiMapperState,
  id: string | undefined,
  role: string | undefined,
): OpencodeUiMapperState {
  if (id === undefined || role === undefined || state.msgRoles.get(id) === role) return state;
  const msgRoles = new Map(state.msgRoles);
  msgRoles.set(id, role);
  return { ...state, msgRoles };
}

/** Track assistant messages seen during the active turn; their latest
 *  snapshots are summed once when `session.idle` closes the turn. */
function withTurnMessage(
  state: OpencodeUiMapperState,
  id: string | undefined,
  role: string | undefined,
): OpencodeUiMapperState {
  if (id === undefined || role !== 'assistant' || state.currentTurnId === null || state.currentTurnMessageIds.has(id)) {
    return state;
  }
  return { ...state, currentTurnMessageIds: new Set(state.currentTurnMessageIds).add(id) };
}

/** Merge an assistant message's `message.updated` telemetry into the per
 *  message record, then re-emit session totals. Monotonic guard: a stale or
 *  zero snapshot never shrinks the record. */
function mergeMessageUsage(
  state: OpencodeUiMapperState,
  id: string,
  info: Record<string, unknown>,
): OpencodeUiMapping {
  const usage = tokensToUsage(info.tokens);
  const cost = num(info.cost);
  if (usage === undefined && cost === undefined) return { events: [], state };
  const prev = state.usageByMessage.get(id) ?? EMPTY_MESSAGE_USAGE;
  const merged: MessageUsage = {
    info: usage && (prev.info === null || usage.total >= prev.info.total) ? usage : prev.info,
    infoCost: maxCost(prev.infoCost, cost),
    steps: prev.steps,
    stepsCost: prev.stepsCost,
  };
  const usageByMessage = new Map(state.usageByMessage);
  usageByMessage.set(id, merged);
  return emitUsage({ ...state, usageByMessage });
}

// ---- parts -------------------------------------------------------------------

function mapPart(props: Record<string, unknown>, state: OpencodeUiMapperState): OpencodeUiMapping {
  const part = isRecord(props.part) ? props.part : props;
  const type = str(part.type);
  const messageID = str(part.messageID);
  const id = str(part.id) ?? messageID;
  if (type === undefined || id === undefined) return { events: [], state };

  const nested = nestForeignPart(str(part.sessionID), state);
  if (nested === undefined) return { events: [], state };
  state = nested.state;
  const parentItemId = nested.parentItemId;

  // Only assistant parts surface — the user's own prompt streams as parts
  // over the same feed. Role is known early (message.updated precedes its
  // parts); an unknown role means "not assistant yet" → skip.
  if (messageID !== undefined && state.msgRoles.get(messageID) !== 'assistant') {
    return { events: [], state };
  }

  switch (type) {
    case 'text':
      return mapTextLike(part, id, 'text', props.delta, parentItemId, state);
    case 'reasoning':
      return mapTextLike(part, id, 'reasoning', props.delta, parentItemId, state);
    case 'tool':
      return mapTool(part, id, parentItemId, state);
    case 'patch':
      return mapPatch(part, id, parentItemId, state);
    case 'subtask':
      return mapSubtask(part, id, parentItemId, state);
    case 'step-finish':
      return mapStepFinish(part, messageID, state);
    default:
      // file, snapshot, step-start, agent, retry, compaction, … — nothing to
      // render yet.
      return { events: [], state };
  }
}

/** Foreign-session parts nest only under the subtask bound to that child
 *  session. A newly seen child claims the oldest pending subtask; with none
 *  pending the part has no home, so the event is dropped (undefined). */
function nestForeignPart(
  partSession: string | undefined,
  state: OpencodeUiMapperState,
): { state: OpencodeUiMapperState; parentItemId: string | undefined } | undefined {
  const foreign = partSession !== undefined && state.sessionId !== null && partSession !== state.sessionId;
  const resolved = foreign && partSession !== undefined ? resolveSubtask(partSession, state) : undefined;
  if (foreign && resolved?.subtask === undefined) return undefined;
  return { state: resolved?.state ?? state, parentItemId: resolved?.subtask?.id };
}

/** Text/reasoning parts carry the FULL accumulated text each update — the
 *  cursor diffs it into true deltas; a server-sent `delta` wins when present.
 *  `time.end` marks the part finished → `item.completed` (once). */
function mapTextLike(
  part: Record<string, unknown>,
  id: string,
  field: 'text' | 'reasoning',
  serverDelta: unknown,
  parentItemId: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  const full = typeof part.text === 'string' ? part.text : '';
  const events: UiEvent[] = [];
  let startedItems: ReadonlySet<string> = state.startedItems;
  let cursors: ReadonlyMap<string, number> = state.cursors;
  let endedItems: ReadonlySet<string> = state.endedItems;

  const makeItem = (text: string): UiMessageItem | UiReasoningItem => {
    const item: UiMessageItem | UiReasoningItem =
      field === 'text'
        ? { kind: 'message', id, role: 'assistant', text }
        : { kind: 'reasoning', id, text };
    if (parentItemId !== undefined) item.parentItemId = parentItemId;
    return item;
  };

  if (!startedItems.has(id)) {
    events.push({ type: 'item.started', item: makeItem('') });
    startedItems = new Set(startedItems).add(id);
  }

  const cursor = cursors.get(id) ?? 0;
  const winning = str(serverDelta);
  let delta: string | undefined;
  let nextCursor = cursor;
  if (winning !== undefined) {
    delta = winning;
    // Keep the cursor consistent with the accumulated text so a later
    // full-text-only update doesn't re-emit what the server delta covered.
    nextCursor = Math.max(cursor + winning.length, full.length);
  } else if (full.length > cursor) {
    delta = full.slice(cursor);
    nextCursor = full.length;
  }
  if (delta !== undefined) {
    events.push({ type: 'item.delta', itemId: id, field, delta });
    const nextCursors = new Map(cursors);
    nextCursors.set(id, nextCursor);
    cursors = nextCursors;
  }

  const time = isRecord(part.time) ? part.time : undefined;
  if (time && num(time.end) !== undefined && !endedItems.has(id)) {
    events.push({ type: 'item.completed', item: makeItem(full) });
    endedItems = new Set(endedItems).add(id);
  }

  if (events.length === 0) return { events, state };
  return { events, state: { ...state, startedItems, cursors, endedItems } };
}

/** The §7.1 direct status map — opencode is the only backend with a real
 *  pending phase, and its `error` state is v2's `failed`. */
export const STATUS_MAP: Readonly<Record<string, ToolStatus>> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  error: 'failed',
};

type TrackedTool = { status: ToolStatus; title: string; live: boolean };

function mapTool(
  part: Record<string, unknown>,
  id: string,
  parentItemId: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  const name = str(part.tool) ?? str(part.name) ?? 'tool';
  const toolState = isRecord(part.state) ? part.state : {};
  const prev: TrackedTool | undefined = state.tools.get(id);
  const mapped = typeof toolState.status === 'string' ? STATUS_MAP[toolState.status] : undefined;
  const status: ToolStatus = mapped ?? prev?.status ?? 'pending';

  const display = toolDisplay(name, toolState.input);
  const { title, live } = toolTitle(toolState, prev, display);
  const metadata = isRecord(toolState.metadata) ? toolState.metadata : undefined;
  const item = toolUiItem(id, name, display, title, status, toolState, metadata, parentItemId);
  const { events, settled } = toolLifecycleEvents(item, prev, status, title);

  let next = state;
  if (events.length > 0) {
    const tools = new Map(state.tools);
    tools.set(id, { status, title, live });
    next = { ...next, tools };
  }
  next = applySubtaskScope(name, item, metadata, settled, events.length > 0, parentItemId, next, prev);
  next = applyTodoWrite(name, toolState, events, next);

  if (events.length === 0 && next === state) return { events, state };
  return { events, state: next };
}

/** The running/completed states carry a live human title ("npm test") — the
 *  wire word wins over the derived one (§7.1). The error state has no title
 *  field (§4.2), so the last LIVE title carries over instead of regressing.
 *  A derived title is re-derived: the pending snapshot's input is often `{}`
 *  (arguments still parsing), and "Task" must become "Task: Dig in" once
 *  the running snapshot brings the description. */
function toolTitle(
  toolState: Record<string, unknown>,
  prev: TrackedTool | undefined,
  display: ReturnType<typeof toolDisplay>,
): { title: string; live: boolean } {
  const wireTitle = str(toolState.title);
  const title = wireTitle ?? (prev?.live ? prev.title : display.title);
  const live = wireTitle !== undefined || (prev?.live ?? false);
  return { title, live };
}

/** Assemble the tool item: input, output on completion, error on failure,
 *  exit code from state metadata, and subagent nesting. */
function toolUiItem(
  id: string,
  name: string,
  display: ReturnType<typeof toolDisplay>,
  title: string,
  status: ToolStatus,
  toolState: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  parentItemId: string | undefined,
): UiToolItem {
  const item: UiToolItem = { kind: 'tool', id, name, toolKind: display.toolKind, title, status };
  if (toolState.input !== undefined) item.input = toolState.input;
  if (status === 'completed') {
    const output = str(toolState.output);
    if (output !== undefined) item.output = output;
  }
  if (status === 'failed') {
    const error = errorText(toolState.error);
    if (error !== undefined) item.error = error;
  }
  const exitCode = metadata ? num(metadata.exit) : undefined;
  if (exitCode !== undefined) item.exitCode = exitCode;
  if (parentItemId !== undefined) item.parentItemId = parentItemId;
  return item;
}

/** Which event (if any) this snapshot emits: started on first sight, completed
 *  once settled, updated on a status flip, and updated on a live-title change
 *  while still running. */
function toolLifecycleEvents(
  item: UiToolItem,
  prev: TrackedTool | undefined,
  status: ToolStatus,
  title: string,
): { events: UiEvent[]; settled: boolean } {
  const settled = status === 'completed' || status === 'failed';
  const events: UiEvent[] = [];
  if (prev === undefined) {
    // First sight — a part already settled is a lone final snapshot
    // (consumers upsert by id, so it renders fine).
    events.push({ type: settled ? 'item.completed' : 'item.started', item });
  } else if (prev.status !== status) {
    events.push({ type: settled ? 'item.completed' : 'item.updated', item });
  } else if (prev.title !== title && !settled) {
    // Same state, new live title (running-state metadata updates).
    events.push({ type: 'item.updated', item });
  }
  return { events, settled };
}

/** A task tool call spawns a child session exactly like a `subtask` part
 *  does (hearsay-tools/cezarion#5). When the snapshot names that child (`metadata.sessionId`,
 *  published as soon as the child exists) the scope binds to it outright;
 *  otherwise it queues for the next child session heard from. A task issued
 *  from inside a child session opens a scope of its own, nested under the
 *  outer one, so its grandchild's output has a home too. */
function applySubtaskScope(
  name: string,
  item: UiToolItem,
  metadata: Record<string, unknown> | undefined,
  settled: boolean,
  hasEvents: boolean,
  parentItemId: string | undefined,
  state: OpencodeUiMapperState,
  prev: TrackedTool | undefined,
): OpencodeUiMapperState {
  if (!isSubtaskTool(name)) return state;
  const childSession = metadata ? (str(metadata.sessionId) ?? str(metadata.sessionID)) : undefined;
  const scope: SubtaskScope = {
    id: item.id,
    name,
    title: item.title,
    ...(item.input !== undefined ? { input: item.input } : {}),
    ...(childSession !== undefined ? { childSession } : {}),
    ...(parentItemId !== undefined ? { parentItemId } : {}),
  };
  let next = state;
  if (!settled) {
    // OpenCode publishes the part before its arguments finish parsing, so
    // the first snapshot is often `{}` and later ones fill the input in —
    // sometimes without moving the status or the derived title, i.e. with
    // no item event. The scope follows every snapshot regardless, or the
    // child's idle would complete it with stale metadata.
    next = prev === undefined ? { ...next, unboundSubtasks: [...next.unboundSubtasks, scope] } : refreshScope(scope, next);
    if (childSession !== undefined) next = bindScope(scope, childSession, next);
  } else if (hasEvents) {
    // The tool's own settlement is authoritative (it carries the output), so
    // its scope is released: a later child idle must not re-complete it. A
    // child the wire named is closed too, even one that never spoke —
    // otherwise its late first event would take a sibling's scope.
    next = releaseScope(item.id, childSession, next);
  }
  return next;
}

/** todowrite IS the plan (full-replacement semantics, deduplicated). */
function applyTodoWrite(
  name: string,
  toolState: Record<string, unknown>,
  events: UiEvent[],
  state: OpencodeUiMapperState,
): OpencodeUiMapperState {
  if (name.toLowerCase() !== 'todowrite') return state;
  const entries = planEntriesOf(toolState.input);
  if (entries === undefined) return state;
  const json = JSON.stringify(entries);
  if (json === state.lastPlanJson) return state;
  events.push({ type: 'plan.updated', entries });
  return { ...state, lastPlanJson: json };
}

/**
 * todowrite input `{todos:[{content,status,priority}]}` → plan entries
 * (an empty list is a valid plan; malformed rows are filtered).
 *
 * `status` is a free-form string upstream (`Schema.String`, not an enum) — its
 * documented vocabulary is pending|in_progress|completed|cancelled. Rows with
 * an unrecognized status fall back to `pending` rather than being dropped: a
 * todo the agent wrote must stay on screen, and dropping it silently shrinks
 * the plan mid-run for no visible reason.
 *
 * A `pending` tool part carries `input: {}` (opencode publishes the part before
 * the arguments finish parsing), which lands on the `!Array.isArray` guard and
 * maps to zero events — so a streaming part cannot clobber a good plan.
 */
function planEntriesOf(input: unknown): PlanEntry[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined;
  const entries: PlanEntry[] = [];
  for (const todo of input.todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string') continue;
    const status = PLAN_STATUSES.find((s) => s === todo.status) ?? 'pending';
    const entry: PlanEntry = { content: todo.content, status };
    if (todo.priority === 'high' || todo.priority === 'medium' || todo.priority === 'low') {
      entry.priority = todo.priority;
    }
    entries.push(entry);
  }
  return entries;
}

export const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

/** `patch` parts snapshot applied file changes → a completed edit-tool item
 *  carrying `diffs` (unified when the wire includes content; the older
 *  paths-only shape still yields per-file entries + locations). */
function mapPatch(
  part: Record<string, unknown>,
  id: string,
  parentItemId: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  if (state.endedItems.has(id)) return { events: [], state };
  const artifacts = patchArtifacts(part.files);
  if (!artifacts) return { events: [], state };
  const { diffs, locations } = artifacts;
  const label =
    locations.length === 1 ? locations[0]?.path : locations.length > 1 ? `${locations.length} files` : undefined;
  const item: UiToolItem = {
    kind: 'tool',
    id,
    name: 'patch',
    toolKind: 'edit',
    title: label !== undefined ? `Edit ${label}` : 'Edit',
    status: 'completed',
    diffs,
    locations,
  };
  if (parentItemId !== undefined) item.parentItemId = parentItemId;
  return {
    events: [{ type: 'item.completed', item }],
    state: { ...state, endedItems: new Set(state.endedItems).add(id) },
  };
}

/** `files` as `{path: unifiedDiff}` record (or `[{path, diff}]`) carries the
 *  content; the paths-only `string[]` shape still yields diff entries.
 *  Opencode sends unified diffs only — old text is unknown, never "empty". */
function patchArtifacts(files: unknown): { diffs: FileDiff[]; locations: ToolLocation[] } | undefined {
  const diffs: FileDiff[] = [];
  const push = (path: string, unified?: string): void => {
    const diff: FileDiff = { path, oldText: null };
    if (unified !== undefined) diff.unified = unified;
    diffs.push(diff);
  };
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (typeof entry === 'string' && entry !== '') push(entry);
      else if (isRecord(entry)) {
        const path = str(entry.path) ?? str(entry.file) ?? str(entry.filename);
        if (path !== undefined) push(path, str(entry.diff) ?? str(entry.patch));
      }
    }
  } else if (isRecord(files)) {
    for (const [path, value] of Object.entries(files)) {
      if (path === '') continue;
      if (typeof value === 'string') push(path, str(value));
      else if (isRecord(value)) push(path, str(value.diff) ?? str(value.patch));
      else push(path);
    }
  }
  if (diffs.length === 0) return undefined;
  return { diffs, locations: diffs.map((d) => ({ path: d.path })) };
}

/** `subtask` parts spawn a child session → a task-kind tool item whose id
 *  scopes subsequent foreign-session items via `parentItemId` (§7.1); the
 *  child's `session.idle` completes it. */
function mapSubtask(
  part: Record<string, unknown>,
  id: string,
  parentItemId: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  if (state.startedItems.has(id)) return { events: [], state };
  const description = str(part.description);
  const display = toolDisplay('task', { description });
  const item: UiToolItem = {
    kind: 'tool',
    id,
    name: 'subtask',
    toolKind: display.toolKind,
    title: display.title,
    status: 'running',
  };
  const input: Record<string, unknown> = {};
  if (str(part.prompt) !== undefined) input.prompt = part.prompt;
  if (description !== undefined) input.description = description;
  if (str(part.agent) !== undefined) input.agent = part.agent;
  if (Object.keys(input).length > 0) item.input = input;
  if (parentItemId !== undefined) item.parentItemId = parentItemId;
  const scope: SubtaskScope = {
    id,
    name: item.name,
    title: item.title,
    ...(item.input !== undefined ? { input: item.input } : {}),
    ...(parentItemId !== undefined ? { parentItemId } : {}),
  };
  return {
    events: [{ type: 'item.started', item }],
    state: {
      ...state,
      startedItems: new Set(state.startedItems).add(id),
      unboundSubtasks: [...state.unboundSubtasks, scope],
    },
  };
}

/** `step-finish` parts carry per-LLM-round-trip cost + tokens → summed as
 *  usage increments (the larger of this sum and the `message.updated`
 *  snapshot wins per message — see `MessageUsage`). */
function mapStepFinish(
  part: Record<string, unknown>,
  messageID: string | undefined,
  state: OpencodeUiMapperState,
): OpencodeUiMapping {
  if (messageID === undefined) return { events: [], state };
  const tokens = tokensToUsage(part.tokens);
  const cost = num(part.cost);
  if (!tokens && cost === undefined) return { events: [], state };
  const prev = state.usageByMessage.get(messageID) ?? EMPTY_MESSAGE_USAGE;
  const merged: MessageUsage = {
    info: prev.info,
    infoCost: prev.infoCost,
    steps: tokens ? addUsage(prev.steps, tokens) : prev.steps,
    stepsCost: cost !== undefined ? (prev.stepsCost ?? 0) + cost : prev.stepsCost,
  };
  const usageByMessage = new Map(state.usageByMessage);
  usageByMessage.set(messageID, merged);
  const currentTurnMessageIds =
    state.currentTurnId !== null
      ? new Set(state.currentTurnMessageIds).add(messageID)
      : state.currentTurnMessageIds;
  return emitUsage({ ...state, usageByMessage, currentTurnMessageIds });
}

/** Replace the scope owned by `scope.id`, bound or still pending, with the
 *  latest snapshot of its title and input. */
function refreshScope(scope: SubtaskScope, state: OpencodeUiMapperState): OpencodeUiMapperState {
  let changed = false;
  const unboundSubtasks = state.unboundSubtasks.map((s) => {
    if (s.id !== scope.id || sameScope(s, scope)) return s;
    changed = true;
    return scope;
  });
  const subtasks = new Map(state.subtasks);
  for (const [sessionId, s] of state.subtasks) {
    if (s.id !== scope.id || sameScope(s, scope)) continue;
    subtasks.set(sessionId, scope);
    changed = true;
  }
  return changed ? { ...state, subtasks, unboundSubtasks } : state;
}

function sameScope(a: SubtaskScope, b: SubtaskScope): boolean {
  return (
    a.name === b.name &&
    a.title === b.title &&
    a.childSession === b.childSession &&
    a.parentItemId === b.parentItemId &&
    JSON.stringify(a.input) === JSON.stringify(b.input)
  );
}

/** Bind `scope` to the child session the wire named for it: out of the
 *  pending queue and into the session map. A scope FIFO had already guessed
 *  onto that session goes back to the head of the queue — the wire outranks
 *  the guess, and that scope's real child is still to be heard from. */
function bindScope(scope: SubtaskScope, childSession: string, state: OpencodeUiMapperState): OpencodeUiMapperState {
  if (state.closedSessions.has(childSession)) return releaseScope(scope.id, undefined, state);
  const current = state.subtasks.get(childSession);
  if (current?.id === scope.id && !state.unboundSubtasks.some((s) => s.id === scope.id)) return state;
  const unboundSubtasks = state.unboundSubtasks.filter((s) => s.id !== scope.id);
  if (current !== undefined && current.id !== scope.id) unboundSubtasks.unshift(current);
  const subtasks = new Map(state.subtasks);
  for (const [sessionId, s] of state.subtasks) if (s.id === scope.id && sessionId !== childSession) subtasks.delete(sessionId);
  subtasks.set(childSession, scope);
  return { ...state, subtasks, unboundSubtasks };
}

/** Drop the scope owned by item `id`, bound or still pending, closing every
 *  child session it was bound to plus the one the wire named (if any). */
function releaseScope(id: string, childSession: string | undefined, state: OpencodeUiMapperState): OpencodeUiMapperState {
  const pending = state.unboundSubtasks.filter((scope) => scope.id !== id);
  const bound = [...state.subtasks].filter(([, scope]) => scope.id === id);
  const named = childSession ?? state.unboundSubtasks.find((scope) => scope.id === id)?.childSession;
  const closeNamed = named !== undefined && !state.closedSessions.has(named);
  if (pending.length === state.unboundSubtasks.length && bound.length === 0 && !closeNamed) return state;
  const subtasks = new Map(state.subtasks);
  const closedSessions = new Set(state.closedSessions);
  for (const [sessionId] of bound) {
    subtasks.delete(sessionId);
    closedSessions.add(sessionId);
  }
  if (named !== undefined) closedSessions.add(named);
  return { ...state, subtasks, unboundSubtasks: pending, closedSessions };
}

function isSubtaskTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'task' || lower === 'subtask';
}

// ---- session lifecycle -------------------------------------------------------

/** `session.idle` is THE turn-end signal (§4.1). The main session's idle
 *  closes the current turn; a foreign idle is the subtask's child session
 *  going quiet → the subtask item completes. */
function mapIdle(props: Record<string, unknown>, state: OpencodeUiMapperState): OpencodeUiMapping {
  const sid = str(props.sessionID);
  const isMain = sid === undefined || state.sessionId === null || sid === state.sessionId;
  if (!isMain) {
    if (sid === undefined) return { events: [], state };
    const resolved = resolveSubtask(sid, state);
    if (resolved.subtask === undefined) return { events: [], state };
    const subtasks = new Map(resolved.state.subtasks);
    subtasks.delete(sid);
    return {
      events: [{ type: 'item.completed', item: completedSubtask(resolved.subtask) }],
      state: { ...resolved.state, subtasks, closedSessions: new Set(resolved.state.closedSessions).add(sid) },
    };
  }
  // Idle with no turn in flight (or a repeated idle) closes nothing.
  if (state.currentTurnId === null) return { events: [], state };
  const openSubtasks = [...state.subtasks.values(), ...state.unboundSubtasks];
  const completed: Extract<UiEvent, { type: 'turn.completed' }> = {
    type: 'turn.completed',
    turnId: state.currentTurnId,
    stopReason: state.turnErrored ? 'error' : 'end_turn',
  };
  const turnUsage = usageForMessages(state.currentTurnMessageIds, state.usageByMessage);
  if (turnUsage.usage !== null) completed.usage = turnUsage.usage;
  if (turnUsage.cost !== null) completed.costUsd = turnUsage.cost;
  return {
    events: [
      ...openSubtasks.map((subtask): UiEvent => ({ type: 'item.completed', item: completedSubtask(subtask) })),
      completed,
    ],
    state: {
      ...state,
      currentTurnId: null,
      currentTurnMessageIds: new Set(),
      turnErrored: false,
      subtasks: new Map(),
      unboundSubtasks: [],
      // Children the turn settled are over too: a delayed event from one must
      // not bind to a scope the NEXT turn queues.
      closedSessions: new Set([...state.closedSessions, ...state.subtasks.keys()]),
    },
  };
}

/** `session.error` → non-fatal `session.error` (the mapper can't know the
 *  session died — the runner owns fatality) + the turn closes as 'error'. */
function mapSessionError(props: Record<string, unknown>, state: OpencodeUiMapperState): OpencodeUiMapping {
  const warning = opencodeSkillWarning(props);
  if (warning) return { events: [{ type: 'session.error', message: warning, fatal: false }], state };
  const sid = str(props.sessionID);
  const foreign = sid !== undefined && state.sessionId !== null && sid !== state.sessionId;
  const resolved = foreign && sid !== undefined ? resolveSubtask(sid, state) : undefined;
  if (foreign && resolved?.subtask === undefined) return { events: [], state };
  state = resolved?.state ?? state;
  const message = errorText(props.error) ?? 'opencode session error';
  return {
    events: [{ type: 'session.error', message, fatal: false }],
    state: { ...state, turnErrored: state.currentTurnId !== null ? true : state.turnErrored },
  };
}

function resolveSubtask(
  sessionId: string,
  state: OpencodeUiMapperState,
): { state: OpencodeUiMapperState; subtask?: SubtaskScope } {
  const existing = state.subtasks.get(sessionId);
  if (existing !== undefined) return { state, subtask: existing };
  // A closed child's late events have no home — never a sibling's scope.
  if (state.closedSessions.has(sessionId)) return { state };
  // First-in-first-out: the oldest pending subtask claims this child session
  // and the rest stay queued for the children still to come (#5).
  const [subtask, ...rest] = state.unboundSubtasks;
  if (subtask === undefined) return { state };
  const subtasks = new Map(state.subtasks);
  subtasks.set(sessionId, subtask);
  return { state: { ...state, subtasks, unboundSubtasks: rest }, subtask };
}

function completedSubtask(subtask: SubtaskScope): UiToolItem {
  const item: UiToolItem = {
    kind: 'tool',
    id: subtask.id,
    name: subtask.name,
    toolKind: 'task',
    title: subtask.title,
    status: 'completed',
  };
  if (subtask.input !== undefined) item.input = subtask.input;
  if (subtask.parentItemId !== undefined) item.parentItemId = subtask.parentItemId;
  return item;
}

// ---- tiny guards ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Opencode error objects are `{name, data:{message}}` (or plain strings). */
function errorText(error: unknown): string | undefined {
  if (typeof error === 'string') return str(error);
  if (!isRecord(error)) return undefined;
  const data = isRecord(error.data) ? error.data : undefined;
  return str(error.message) ?? (data && str(data.message)) ?? str(error.name);
}
