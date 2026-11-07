/**
 * Sub-agent row and registry state for the OMP UI mapper: the synthetic batch `task` row, the
 * sub-agent registry accessors, the child item scope, and the plan entries a `todo` result
 * carries. Types come from the mapper; nothing here imports mapper functions.
 */
import type {
  OmpSubagentEntry,
  OmpUiMapperState,
  ItemScope,
} from './omp-ui-mapper.ts';
import type { PlanEntry, UiEvent, UiToolItem } from './ui-events.js';
import { toolDisplay } from '@open-mercato/cezar-contract/tool-display';
import { isRecord, number, string } from './pi-rpc-wire.ts';

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
export function ompToolPlan(name: string, result: Record<string, unknown>): PlanEntry[] | undefined {
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

export function lifecycleStatus(status: string | undefined): UiToolItem['status'] {
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

function startedBatchRow(
  payload: Record<string, unknown>,
  id: string,
  rowId: string,
  parent: UiToolItem | undefined,
  state: OmpUiMapperState,
  events: UiEvent[],
): OmpUiMapperState {
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
  events.push({ type: 'item.started', item });
  return { ...state, tools };
}

export function startSubagentEntry(
  payload: Record<string, unknown>,
  id: string,
  parentToolCallId: string,
  status: UiToolItem['status'],
  state: OmpUiMapperState,
  events: UiEvent[],
): { entry: OmpSubagentEntry; state: OmpUiMapperState } {
  const parent = parentToolCallId ? state.tools.get(parentToolCallId) : undefined;
  // A single-form call IS the sub-agent's row; a batch call (or an unknown parent) gets one
  // synthetic `task` row per sub-agent so the drawer counts agents, not calls.
  const single = parent !== undefined && !state.batchCalls.has(parentToolCallId);
  const rowId = single ? parentToolCallId : `${parentToolCallId || 'omp-subagent'}#${id}`;
  const entry: OmpSubagentEntry = { rowId, parentToolCallId, status, ended: false };
  let next = withSubagent(state, id, entry);
  if (!single) next = startedBatchRow(payload, id, rowId, parent, next, events);
  return { entry, state: next };
}

/** The sub-agent whose single-form `task` call is row `rowId`, with its id. */
export function singleFormSubagent(state: OmpUiMapperState, rowId: string): [string, OmpSubagentEntry] | undefined {
  for (const [id, entry] of state.subagents) {
    if (entry.rowId === rowId && entry.parentToolCallId === rowId) return [id, entry];
  }
  return undefined;
}

export function withSubagent(state: OmpUiMapperState, id: string, entry: OmpSubagentEntry): OmpUiMapperState {
  const subagents = new Map(state.subagents);
  subagents.set(id, entry);
  return { ...state, subagents };
}

export function childScope(rowId: string): ItemScope {
  return { textPrefix: `${rowId}/`, toolPrefix: `${rowId}/`, parentItemId: rowId };
}
