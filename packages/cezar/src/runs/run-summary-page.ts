import { toRunSummary, type RunSummary } from '@open-mercato/cezar-contract/runs';
import type { RunDatabase } from './run-database.ts';
import type { RunRecord } from './store.ts';

type Order = { createdAt: string; seq: number };
type Ranked = readonly [RunSummary, Order];
export type PeerTaskPageOptions = { callerId: string; all?: boolean | undefined; offset?: number | undefined };
type PageContext = {
  db: RunDatabase | null; held: ReadonlyMap<string, RunRecord>; skipped: ReadonlySet<string>;
  order(run: RunRecord): Order; cold(id: string): RunSummary | undefined;
};
function heldPeers(context: PageContext, options: PeerTaskPageOptions): Ranked[] {
  return [...context.held.values()].filter(run => run.id !== options.callerId &&
    (run.delegation === undefined || (run.delegation.role === 'root' && !run.delegation.historyDeletion)) &&
    (options.all || !run.archived) && !context.skipped.has(run.id)).map(run => [toRunSummary(run), context.order(run)]);
}

/** Cold history stays in SQLite. Only a page plus the live overlay enters memory.
 * Skip at most H fewer DB rows than the requested offset, where H is the overlay size;
 * sorting those H held rows with the bounded DB slice restores their exact list ranks. */
export function listPeerTaskSummaries(context: PageContext, options: PeerTaskPageOptions): { runs: RunSummary[]; nextOffset?: number } {
  const held = heldPeers(context, options);
  const offset = options.offset ?? 0;
  const dbOffset = Math.max(0, offset - held.length);
  const excluded = [...context.skipped, ...context.held.keys(), options.callerId];
  const rows = context.db?.listPeerSummaries({ all: options.all ?? false, excluded, offset: dbOffset, limit: 33 + held.length }) ?? [];
  const cold: Ranked[] = rows.flatMap(row => {
    const summary = parseStoredSummary(row.summary) ?? context.cold(row.id);
    return summary ? [[summary, row] as const] : [];
  });
  const ranked = [...cold, ...held].sort(([, a], [, b]) => a.createdAt === b.createdAt ? a.seq - b.seq : a.createdAt < b.createdAt ? 1 : -1);
  const page = ranked.slice(offset - dbOffset, offset - dbOffset + 33).map(([summary]) => summary);
  return { runs: page.slice(0, 32), ...(page.length > 32 ? { nextOffset: offset + 32 } : {}) };
}

/**
 * A stored summary, or undefined when the row holds none (a row seeded without one, or text that
 * is not a summary): the caller then projects the record instead. The column is written only by
 * `encodeRunRow`, from a record the schema accepted, so this checks the shape a list row cannot
 * do without rather than running the full contract schema — on a cockpit's thousand rows that
 * schema costs more than reading them. The cold reader (`run-index.ts`), which reads other
 * projects' databases, still validates in full.
 */
export function parseStoredSummary(text: string): RunSummary | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object') return undefined;
    const row = raw as Record<string, unknown>;
    return typeof row.id === 'string' && typeof row.title === 'string' && typeof row.status === 'string' &&
      typeof row.createdAt === 'string' && typeof row.archived === 'boolean' ? raw as RunSummary : undefined;
  } catch {
    return undefined;
  }
}

