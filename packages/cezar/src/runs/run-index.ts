import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSummarySchema, toRunSummary, type RunSummary } from '@open-mercato/cezar-contract';

import { RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase, type RunSummaryRow } from './run-database.ts';
import { decodeRunRecord, LEGACY_INDEX_FILE, reconcileLoadedRun, rescopeRun, parseRunRecords, type RepoHandle, type RunRecord } from './store.ts';
import { refreshHumanAskSummary } from './human-ask-summary.ts';
import { matchesRunQuery, sqlPrefilterTokens } from './run-search.ts';

/** A cold project's runs as list rows, and whether older archived roots were left out. */
export interface ColdRunIndex {
  runs: RunSummary[];
  truncated: boolean;
}

const EMPTY: ColdRunIndex = { runs: [], truncated: false };

/** Projects whose unreadable rows this process has already reported: ⌘K reads the index on every
 *  keystroke's request, and one warning per project is enough. */
const reportedUnreadable = new Set<string>();

/**
 * The READ-ONLY reader of a project's runs, for the workspace-level run index (`GET
 * /workspace/runs-index`) — the one place that must read a project's runs WITHOUT owning it.
 *
 * `RunStore.open` cannot be used here and the reason is the whole point of this module. Opening a
 * store `mkdir`s `<dataDir>/runs/`, migrates or imports `runs.db`, and the caller that opens one
 * goes on to build a `ProjectContext` — which prunes orphan worktrees and calls
 * `manager.recover()`, resuming interrupted runs. Building the workspace index must never do any
 * of that: answering "which tasks exist" would restart agents across every registered project,
 * and typing into a search box would spend tokens. Cold projects are precisely the ones the index
 * exists to reach, so `contexts.peek()` (which returns nothing for them) is not an answer either.
 *
 * Once a project's `runs.db` has completed its import it is the only source: `runs.json` beside it
 * is frozen history (#779). The rows — with `archivedWindow`, the run lists' window (#864): every
 * unarchived run plus the newest archived roots — come from the stored summary column, read
 * through a read-only connection that creates no directory or database and runs no migration.
 * Before that, the legacy `runs.json` is parsed read-only, exactly as it always was. A database
 * that exists but cannot be read contributes nothing — never the stale `runs.json` beside it.
 *
 * What this does share with the store is the schema and `reconcileLoadedRun`, so a `running` row
 * left behind by a crashed process reads as interrupted here exactly as it would once the project
 * were opened for real. A second, subtly different parse of that field would show a task as
 * running in the palette and failed the moment you clicked it.
 */
export function readRunIndexFromDisk(
  dataDir: string,
  options: { handle?: RepoHandle | null; archivedWindow?: number; roots?: boolean } = {},
): ColdRunIndex {
  return readCold(dataDir, EMPTY, (db) => readDatabase(db, dataDir, options), () => readLegacyIndex(dataDir, options));
}

/**
 * A cold project's ROOT runs, archived or not, that match `query` (`matchesRunQuery`), newest
 * first: at most `limit`, and whether more matched. The workspace search behind ⌘K (#864), with
 * the same side-effect-free contract as `readRunIndexFromDisk`.
 */
export function searchRunIndexFromDisk(
  dataDir: string,
  query: string,
  options: { handle?: RepoHandle | null; limit: number },
): ColdRunIndex {
  return readCold(dataDir, EMPTY, (db) => searchDatabase(db, dataDir, query, options), () => {
    const { runs } = readLegacyIndex(dataDir, options);
    return firstMatches(runs.filter((run) => run.delegation?.role !== 'worker'), query, options.limit);
  });
}

/** The source rule both readers share: an imported `runs.db` is the only source, a `runs.db` that
 *  cannot be read contributes `empty`, and before the import the legacy `runs.json` is read. */
function readCold<T>(dataDir: string, empty: T, fromDatabase: (db: RunDatabase) => T, fromLegacy: () => T): T {
  let db: RunDatabase | null;
  try {
    db = RunDatabase.openReadOnly(join(dataDir, RUNS_DB_FILE));
  } catch {
    return empty;
  }
  if (db) {
    try {
      if (db.getMeta(RUNS_IMPORT_COMPLETE_KEY) !== undefined) return fromDatabase(db);
    } catch {
      return empty;
    } finally {
      db.close();
    }
  }
  return fromLegacy();
}

/** The newest `limit` of `runs` that match, and whether another one did. */
function firstMatches(runs: readonly RunSummary[], query: string, limit: number): ColdRunIndex {
  const matched: RunSummary[] = [];
  for (const run of runs) {
    if (!matchesRunQuery(run, query)) continue;
    if (matched.length === limit) return { runs: matched, truncated: true };
    matched.push(run);
  }
  return { runs: matched, truncated: false };
}

/** `runs` (newest first) with archived roots past `archivedWindow` cut, and whether any were. */
function applyWindow<T extends { archived: boolean }>(runs: T[], archivedWindow: number | undefined): { runs: T[]; truncated: boolean } {
  if (archivedWindow === undefined) return { runs, truncated: false };
  let archived = 0;
  const kept = runs.filter((run) => !run.archived || ++archived <= archivedWindow);
  return { runs: kept, truncated: archived > archivedWindow };
}

function readDatabase(db: RunDatabase, dataDir: string, { handle, archivedWindow, roots }: { handle?: RepoHandle | null; archivedWindow?: number; roots?: boolean }): ColdRunIndex {
  // One archived root past the window is how "there are older ones" is known without counting.
  const rows = archivedWindow === undefined ? db.listSummaries() : db.listWindowSummaries(archivedWindow + 1, { roots });
  return applyWindow(projectRows(db, rows, dataDir, handle), archivedWindow);
}

function searchDatabase(db: RunDatabase, dataDir: string, query: string, { handle, limit }: { handle?: RepoHandle | null; limit: number }): ColdRunIndex {
  // Match on the stored summary first, so only candidates pay for a decode; each candidate is
  // projected and matched again as it is read, because reading it cold can drop a foreign
  // reference it matched on. The scan stops at one match past the limit counted AFTER that, so
  // dropped candidates can never use up the cap and hide an older real match (#864 review).
  const matched: RunSummary[] = [];
  db.visitRootSummaries(sqlPrefilterTokens(query), (row) => {
    const summary = parseSummary(row.summary);
    if (summary !== undefined && !matchesRunQuery(summary, query)) return true;
    const [projected] = projectRows(db, [row], dataDir, handle);
    if (projected && matchesRunQuery(projected, query)) matched.push(projected);
    return matched.length <= limit;
  });
  return matched.length > limit ? { runs: matched.slice(0, limit), truncated: true } : { runs: matched, truncated: false };
}

/** Rows as list rows: the stored summary when reading cold cannot change it, else the decoded
 *  record projected as the store would. A row that decodes to nothing is left out. */
function projectRows(db: RunDatabase, rows: readonly RunSummaryRow[], dataDir: string, handle?: RepoHandle | null): RunSummary[] {
  const summaries = rows.map((row) => parseSummary(row.summary));
  const decode = rows.filter((row, i) => {
    const summary = summaries[i];
    return summary === undefined || needsRecord(summary, handle);
  });
  const records = new Map(db.getMany(decode.map((row) => row.id)).map((row) => [row.id, decodeRunRecord(row.data)]));
  const runs: RunSummary[] = [];
  let unreadable = 0;
  rows.forEach((row, i) => {
    const summary = summaries[i];
    if (summary !== undefined && !needsRecord(summary, handle)) {
      runs.push(summary);
      return;
    }
    // A row that decodes to nothing is one the store leaves out of its list rows too.
    const record = records.get(row.id);
    if (record) runs.push(coldSummary(record, dataDir, handle));
    else unreadable++;
  });
  if (unreadable > 0 && !reportedUnreadable.has(dataDir)) {
    reportedUnreadable.add(dataDir);
    console.warn(`[cez] ${unreadable} run(s) in ${join(dataDir, RUNS_DB_FILE)} could not be read; they are left out of the run index and left in the database untouched.`);
  }
  return runs;
}

function parseSummary(text: string): RunSummary | undefined {
  try {
    const parsed = runSummarySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether reading this run cold could change its stored summary: the questions
 * `reconcileLoadedRun`, `rescopeRun` and the ask refresh would answer, asked of the summary. Only
 * these runs pay for decoding their full record; every other row is served as stored.
 *
 * One case is invisible from here: a finished run that still carries an accepted Stop (`stopping`
 * is not in the summary) would read as cancelled once its record were decoded. The writer clears
 * `stopping` as the run settles, so that takes a crash inside that window.
 */
function needsRecord(summary: RunSummary, handle?: RepoHandle | null): boolean {
  // A live-looking run reads as interrupted (or cancelled, after an accepted Stop).
  if (summary.status === 'queued' || summary.status === 'running' || summary.status === 'waiting') return true;
  // Monitoring state, and a usage-limit resume on anything but a failed run, are cleared.
  if (summary.activity !== undefined) return true;
  if (summary.autoResumeAt !== undefined && summary.status !== 'failed') return true;
  // A referenced PR that an older cezar's created-PR declaration erased is restored.
  if (summary.referencedPullRequestUrl === undefined && summary.markerRefs?.pr !== undefined) return true;
  // A foreign reference the prompt does not corroborate is dropped; the prompt is in the record.
  if (handle && (summary.referencedPullRequestUrl !== undefined || summary.referencedIssueUrl !== undefined)) return true;
  // A root waiting on workers has its pending human question re-read from the transcript.
  return summary.delegation?.role === 'root' && summary.delegation.wait !== undefined;
}

function readLegacyIndex(dataDir: string, { handle, archivedWindow, roots }: { handle?: RepoHandle | null; archivedWindow?: number; roots?: boolean }): ColdRunIndex {
  const indexPath = join(dataDir, LEGACY_INDEX_FILE);
  if (!existsSync(indexPath)) return EMPTY;
  try {
    const raw: unknown = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(raw)) return EMPTY;
    // A record that does not parse costs that record only, exactly as its import will (store.ts).
    const records = raw.flatMap((entry: unknown) => {
      const parsed = parseRunRecords([entry]);
      return parsed.success ? parsed.data : [];
    });
    // The window leaves archived workers out, as `RunDatabase.listWindowSummaries` does, and
    // with `roots` every worker.
    const listed = archivedWindow === undefined
      ? records
      : records.filter((run) => run.delegation?.role !== 'worker' || (!run.archived && !roots));
    // Reconciling never moves `createdAt` or `archived`, so the window is cut before projecting.
    const newest = listed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const { runs: kept, truncated } = applyWindow(newest, archivedWindow);
    return { runs: kept.map((run) => coldSummary(run, dataDir, handle)), truncated };
  } catch {
    // Corrupt or unreadable index. A project that cannot be read contributes nothing to the
    // index rather than failing the whole workspace's search — the same degrade-quietly rule
    // the rest of the registry follows.
    return EMPTY;
  }
}

/**
 * One record read cold, as its list row. `reconcileLoadedRun` mutates, which is safe here in a way
 * it is not in the store: the record was just parsed into a fresh object nothing else holds.
 * Never `keepLive` — this reader has no RunManager, so there is nothing to recover into.
 */
function coldSummary(run: RunRecord, dataDir: string, handle?: RepoHandle | null): RunSummary {
  if (run.delegation?.role === 'root' && (run.status === 'waiting' || run.delegation.wait !== undefined)) {
    refreshHumanAskSummary(run, dataDir);
  }
  reconcileLoadedRun(run);
  rescopeRun(run, handle);
  return toRunSummary(run);
}
