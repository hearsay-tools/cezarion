import { WAIT_KINDS } from '../workflows/run/wait-kinds.ts';
/**
 * Collect a family that may archive. `RunStore.archiveFamily` is a thin call into
 * `archiveStoreFamily`; unnormalized evidence, ownership and activity checks stay here.
 */
import { runPullRequestSchema } from '@open-mercato/cezar-contract/runs';
import type { RunRecord } from '@open-mercato/cezar-contract';
import { isLiveRecord } from './run-row.ts';
import type { RunRow } from './run-database.ts';
import type { WorkerExecution } from './worker-execution.ts';
import type { TranscriptFacts } from './transcript-facts.ts';

/** The run `decodeRunRow` returns; archive collection ignores extras. */
type DecodedArchiveRun = { run: RunRecord };

/** The store methods family-archive collection needs; no import of `store.ts`. */
export interface ArchiveFamilyState {
  db: { listIdsByParent(id: string): string[]; get(id: string): RunRow | undefined } | null;
  held: ReadonlyMap<string, RunRecord>;
  deleted: ReadonlySet<string>;
  quarantined: ReadonlySet<string>;
  pins: ReadonlyMap<string, unknown>;
  listWorkersOf(id: string): Array<{ id: string }>;
  setArchiveBlocker(id: string, blocker: RunRecord['archiveBlocker']): void;
  decodeRunRow(data: string): DecodedArchiveRun | undefined;
  decodeCold(row: RunRow): RunRecord | undefined;
  writeRefusal(id: string): string | undefined;
  factsPeek(id: string): Readonly<TranscriptFacts> | undefined;
  readWorkerExecution(id: string): WorkerExecution | undefined;
}

/**
 * Use unnormalized persisted evidence: cold reads must not turn interrupted work into safety.
 */
export function archiveStoreFamily(
  state: ArchiveFamilyState,
  id: string,
  isActive: (id: string) => boolean,
): RunRecord[] | undefined {
  const ids = familyArchiveIds(state, id);
  if (ids.length > 1025) return undefined;
  const family: RunRecord[] = [];
  const block = (message: string, runId = id) => { state.setArchiveBlocker(id, { message, runId }); return undefined; };
  for (const memberId of ids) {
    const member = inspectArchiveMember(state, memberId, isActive);
    if (!member.ok) return block(member.message, memberId);
    family.push(member.run);
  }
  if (family[0]?.delegation?.role === 'worker' || family[0]?.archived) return undefined;
  return family;
}

function familyArchiveIds(state: ArchiveFamilyState, id: string): string[] {
  return [id, ...new Set([...(state.db?.listIdsByParent(id) ?? []), ...state.listWorkersOf(id).map((run) => run.id)])];
}

type ArchiveMember =
  | { ok: true; run: RunRecord; row?: RunRow }
  | { ok: false; message: string };

function inspectArchiveMember(
  state: ArchiveFamilyState,
  memberId: string,
  isActive: (id: string) => boolean,
): ArchiveMember {
  const loaded = loadArchiveMember(state, memberId);
  if (!loaded.ok) return loaded;
  return checkArchiveMember(state, memberId, loaded.run, loaded.row, isActive);
}

function loadArchiveMember(
  state: ArchiveFamilyState,
  memberId: string,
): ArchiveMember {
  const row = state.db?.get(memberId);
  const raw: unknown = row ? JSON.parse(row.data) : state.held.get(memberId);
  const decoded = state.decodeRunRow(JSON.stringify(raw));
  if (!decoded) return { ok: false, message: 'Task history is unavailable. Open the task or archive it manually.' };
  if (malformedArchivePullRequests(raw)) {
    return { ok: false, message: 'PR associations are invalid. Check the task PRs or archive manually.' };
  }
  const run = state.held.get(memberId) ?? decoded.run;
  if (row && !state.held.has(memberId)) state.decodeCold(row); // records the synchronous write fence
  return row ? { ok: true, run, row } : { ok: true, run };
}

function malformedArchivePullRequests(raw: unknown): boolean {
  // Do not let the runtime schema's per-entry salvage hide malformed PR authority.
  return Boolean(raw && typeof raw === 'object' && 'pullRequests' in raw &&
    (!Array.isArray(raw.pullRequests) || raw.pullRequests.some((entry) => !runPullRequestSchema.safeParse(entry).success)));
}

function checkArchiveMember(
  state: ArchiveFamilyState,
  memberId: string,
  run: RunRecord,
  row: RunRow | undefined,
  isActive: (id: string) => boolean,
): ArchiveMember {
  const ownership = archiveMemberOwnershipBlocker(state, memberId, run, row, isActive);
  if (ownership) return { ok: false, message: ownership };
  const pending = archiveMemberPendingBlocker(state, memberId, run);
  if (pending) return { ok: false, message: pending };
  // Process and scratch cleanup evidence protects deletion, not reversible filing.
  return { ok: true, run };
}

function archiveMemberOwnershipBlocker(
  state: ArchiveFamilyState,
  memberId: string,
  run: RunRecord,
  row: RunRow | undefined,
  isActive: (id: string) => boolean,
): string | undefined {
  if (state.deleted.has(memberId) || state.quarantined.has(memberId) || state.writeRefusal(memberId)) {
    return 'Task history is owned elsewhere or cannot be changed. Retry after its owner stops.';
  }
  if (state.pins.has(memberId) || isActive(memberId) || isLiveRecord(run) || row?.live ||
    !['review', 'done', 'failed', 'cancelled'].includes(run.status)) {
    return 'Task work is still active. Wait for it to finish or archive manually.';
  }
  return undefined;
}

function archiveMemberPendingBlocker(
  state: ArchiveFamilyState,
  memberId: string,
  run: RunRecord,
): string | undefined {
  if (run.waits?.some((wait) => WAIT_KINDS[wait.kind].userAnswers && wait.phase === 'open') || run.hasPendingPermission) {
    return 'Task needs an answer or permission. Open it to respond, or archive manually.';
  }
  if (run.delegation?.role === 'invalid') return 'Worker ownership is invalid. Inspect the task or archive manually.';
  const facts = state.factsPeek(memberId);
  if (!facts || facts.pendingAsk !== undefined) {
    return 'Task has an unanswered question or unread history. Open it to respond, or archive manually.';
  }
  if (run.delegation?.role === 'worker' && state.readWorkerExecution(memberId)?.phase !== 'complete') {
    return 'Worker execution has not settled. Open the worker or archive manually.';
  }
  return undefined;
}
