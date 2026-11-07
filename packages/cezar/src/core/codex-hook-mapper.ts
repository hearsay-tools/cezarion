/**
 * `hook/completed` → the hook item (hearsay-tools/cezarion#961): the entry
 * list, the joined status message, the optional source/duration fields, and
 * the subagent nesting via `collabParentItemId`.
 */

import type { CodexUiMapperState } from './codex-ui-mapper-state.ts';
import { hookEventName, isVisibleHookItem } from './hook-items.ts';
import { isRecord, number as num } from './pi-rpc-wire.ts';
import type { HookEntryKind, HookStatus, UiEvent, UiHookItem } from './ui-events.ts';

export const HOOK_STATUS: Readonly<Record<string, HookStatus>> = {
  completed: 'completed',
  failed: 'failed',
  blocked: 'blocked',
  stopped: 'cancelled',
};
const HOOK_ENTRY_KINDS = new Set<HookEntryKind>(['context', 'feedback', 'warning', 'error', 'stop']);

/** `hook/completed` → one hook item
 *  (hearsay-tools/cezarion#961). `run.entries` already are what the agent
 *  received; `statusMessage` joins them unless an entry already says it. */
function mapHookCompleted(params: Record<string, unknown>, state: CodexUiMapperState): UiEvent[] {
  const run = isRecord(params.run) ? params.run : undefined;
  const id = str(run?.id);
  const eventName = str(run?.eventName);
  const status = typeof run?.status === 'string' ? HOOK_STATUS[run.status] : undefined;
  if (!run || id === undefined || eventName === undefined || status === undefined) return [];
  const entries = hookEntries(run, status);
  const item = hookItem(run, id, eventName, status, entries, params, state);
  return isVisibleHookItem(item) ? [{ type: 'item.completed', item }] : [];
}

/** The agent-visible entry list: the run's own entries, then `statusMessage`
 *  joined as a warning/error unless an entry already says it. */
function hookEntries(run: Record<string, unknown>, status: HookStatus): UiHookItem['entries'] {
  const entries: UiHookItem['entries'] = [];
  for (const raw of Array.isArray(run.entries) ? run.entries : []) {
    if (!isRecord(raw) || typeof raw.text !== 'string' || raw.text.trim() === '') continue;
    const kind = raw.kind as HookEntryKind;
    if (HOOK_ENTRY_KINDS.has(kind)) entries.push({ kind, text: raw.text });
  }
  const message = str(run.statusMessage)?.trim();
  if (message && !entries.some((entry) => entry.text.trim() === message)) {
    entries.push({ kind: status === 'completed' ? 'warning' : 'error', text: message });
  }
  return entries;
}

/** Assemble the hook item with its optional source, duration and subagent
 *  nesting. */
function hookItem(
  run: Record<string, unknown>,
  id: string,
  eventName: string,
  status: HookStatus,
  entries: UiHookItem['entries'],
  params: Record<string, unknown>,
  state: CodexUiMapperState,
): UiHookItem {
  const item: UiHookItem = { kind: 'hook', id: `hook_${id}`, event: hookEventName(eventName), status, entries };
  const source = str(run.sourcePath);
  if (source !== undefined) item.source = source;
  const durationMs = num(run.durationMs);
  if (durationMs !== undefined) item.durationMs = durationMs;
  const parentItemId = collabParentItemId(params, state);
  if (parentItemId !== undefined) item.parentItemId = parentItemId;
  return item;
}

function collabParentItemId(params: Record<string, unknown>, state: CodexUiMapperState): string | undefined {
  const threadId = threadIdOf(params);
  return threadId ? state.collabTasks.get(threadId)?.itemId : undefined;
}

function threadIdOf(params: Record<string, unknown>): string | undefined {
  const thread = isRecord(params.thread) ? params.thread : undefined;
  return (thread && str(thread.id)) ?? str(params.threadId);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export { mapHookCompleted, collabParentItemId, threadIdOf };
