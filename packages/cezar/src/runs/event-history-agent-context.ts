import type { RunHistoryEvent } from '@open-mercato/cezar-contract/events';

import type { BoundaryContextTracker } from './event-history-context.ts';

interface ContextItem {
  id: string;
  parentId?: string;
  turn: number;
  first: RunHistoryEvent;
  latest: RunHistoryEvent;
  status?: string | undefined;
}

interface ContextToolItem {
  id: string;
  toolKind?: unknown;
  parentItemId?: unknown;
  status?: unknown;
}

function contextToolItem(event: RunHistoryEvent): ContextToolItem | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') return undefined;
  const raw = event.item;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const item = raw as { id?: unknown; kind?: unknown };
  if (item.kind !== 'tool' || typeof item.id !== 'string' || item.id === '') return undefined;
  return item as ContextToolItem;
}

const isSettledContextStatus = (status: string | undefined) =>
  status !== undefined && status !== 'pending' && status !== 'running';

export class AgentItemsContextTracker {
  private readonly roots = new Map<string, ContextItem>();
  private readonly children = new Map<string, ContextItem>();
  private readonly rootsByTurn = new Map<number, Set<string>>();

  constructor(private readonly boundaries: BoundaryContextTracker) {}

  observe(event: RunHistoryEvent): void {
    if (event.type === 'user-message' || event.type === 'turn.started') {
      this.pruneSettledHistory();
      return;
    }
    const item = contextToolItem(event);
    if (!item) return;
    const parentId = typeof item.parentItemId === 'string' ? item.parentItemId : undefined;
    const isRoot = item.toolKind === 'task' && parentId === undefined;
    if (!isRoot && parentId === undefined) return;
    this.retainItem(event, item, parentId, isRoot);
    this.pruneSettledHistory();
  }

  private retainItem(event: RunHistoryEvent, item: ContextToolItem, parentId: string | undefined, isRoot: boolean): void {
    const key = `${event.stepId ?? ''}:${item.id}`;
    const collection = isRoot ? this.roots : this.children;
    const existing = collection.get(key);
    const turn = this.boundaries.turn;
    const next: ContextItem = existing
      ? { ...existing, latest: event, status: typeof item.status === 'string' ? item.status : existing.status }
      : {
          id: item.id,
          ...(parentId === undefined ? {} : { parentId }),
          turn,
          first: event,
          latest: event,
          ...(typeof item.status === 'string' ? { status: item.status } : {}),
        };
    collection.set(key, next);
    if (isRoot && !existing) {
      const ids = this.rootsByTurn.get(turn);
      if (ids) ids.add(key);
      else this.rootsByTurn.set(turn, new Set([key]));
    }
  }

  pruneSettledHistory(): void {
    const rootTurns = [...this.rootsByTurn.keys()].sort((a, b) => a - b);
    const latestRootTurn = rootTurns.at(-1);
    if (latestRootTurn === undefined) return;
    let pruneThrough: number | undefined;
    for (let index = rootTurns.length - 2; index >= 0; index -= 1) {
      const candidate = rootTurns[index]!;
      const ids = this.rootsByTurn.get(candidate)!;
      if ([...ids].every((id) => isSettledContextStatus(this.roots.get(id)?.status))) {
        pruneThrough = candidate;
        break;
      }
    }
    const latestIds = this.rootsByTurn.get(latestRootTurn)!;
    if (
      this.boundaries.turn > latestRootTurn &&
      [...latestIds].every((id) => isSettledContextStatus(this.roots.get(id)?.status))
    ) {
      pruneThrough = latestRootTurn;
    }
    if (pruneThrough === undefined) return;
    for (const [candidateTurn, ids] of this.rootsByTurn) {
      if (candidateTurn > pruneThrough) continue;
      for (const id of ids) this.roots.delete(id);
      this.rootsByTurn.delete(candidateTurn);
    }
    const retainedRootIds = this.retainedRootIds();
    for (const [key, item] of this.children) {
      if (item.parentId === undefined || !retainedRootIds.has(item.parentId)) this.children.delete(key);
    }
    const earliest = Math.min(...[...this.roots.values()].map(({ first }) => first.seq), Number.MAX_SAFE_INTEGER);
    this.boundaries.pruneBefore(earliest);
  }

  private retainedRootIds(): Set<string> {
    return new Set([...this.roots.values()].map(({ id }) => id));
  }

  events(): RunHistoryEvent[] {
    const retainedRootIds = this.retainedRootIds();
    const relevantChildren = [...this.children.values()].filter(
      ({ parentId }) => parentId !== undefined && retainedRootIds.has(parentId),
    );
    return [...this.roots.values(), ...relevantChildren].flatMap(item => [item.first, item.latest]);
  }
}
