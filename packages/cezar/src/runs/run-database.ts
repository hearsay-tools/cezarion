import { accessSync, closeSync, constants, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * The transactional run store underneath `RunStore` (#779, plan step 2).
 *
 * One SQLite file per project, `<dataDir>/runs.db`, holding every run as a complete JSON record
 * plus the handful of columns the store has to query without decoding that record. The module is
 * deliberately schema-agnostic: it never imports `RunRecord`, never parses `data` or `summary`,
 * and never decides what a column's value should be. The caller (RunStore's codec) computes them
 * and hands over strings, so the record schema can change without this file noticing.
 *
 * Everything is synchronous, like the store it serves. Writes go through ONE entry point,
 * `transaction()`, which commits a whole change set or nothing — the property `runs.json`'s
 * debounced whole-file rewrite only approximated.
 *
 * Failure policy: every SQLite error leaves as a typed `RunDatabaseError` (`toRunDatabaseError`),
 * and nothing here ever deletes, truncates or "repairs" a file. A corrupt database, WAL or SHM
 * stays exactly where it is for the user (or a later recovery step) to inspect.
 */

export const RUNS_DB_FILE = 'runs.db';

/** `meta` key whose presence means the legacy `runs.json` import committed (or there was nothing
 *  to import): from then on this database is authoritative and `runs.json` is history. Written in
 *  the same transaction as the imported rows, so it can never describe a half-finished import. */
export const RUNS_IMPORT_COMPLETE_KEY = 'import-complete';

/** `PRAGMA user_version` of a database this build created. A higher number means a newer cezar
 *  wrote it; that is refused rather than read, because a newer schema may store what this one
 *  would silently drop on its next write. */
export const RUN_DATABASE_SCHEMA_VERSION = 1;

/** How long a statement waits on another connection's lock before failing as busy. Short on
 *  purpose: the store runs on the event loop, and a blocked write is a blocked cockpit. */
const BUSY_TIMEOUT_MS = 50;

/**
 * Forward-only migrations: entry `i` takes a database from `user_version` i to i + 1. Never edit
 * a shipped entry; append a new one and raise `RUN_DATABASE_SCHEMA_VERSION`.
 */
const MIGRATIONS: readonly string[] = [
  `
  -- Every column beyond id/data/summary/revision exists for a query the spec names. They are
  -- copies of record fields (or of one predicate over the record), computed by the caller in the
  -- same upsert as data and summary, so a row can never disagree with its own columns.
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    -- Newest-first order: GET /run-summaries, /workspace/runs-index, the cold newest-200 read,
    -- and count-based history retention (the runs past the newest N).
    created_at TEXT NOT NULL,
    -- Worktree retention: most recently finished first (falls back to created_at).
    finished_at TEXT,
    -- The mark-all-read and archive-finished sweeps select finished statuses.
    status TEXT NOT NULL,
    -- History retention, mark-all-read and archive-finished skip or select archived runs (0/1).
    archived INTEGER NOT NULL,
    -- isLiveRecord() (run-row.ts): the rows RunStore.open loads into memory and recovers. Every
    -- other row stays here until something reads it.
    live INTEGER NOT NULL,
    -- The workers of a parent (delegation.parentRunId): delegation families, archive cascades and
    -- the "every worker" recovery passes, replacing whole-map scans.
    parent_run_id TEXT,
    -- The run an idempotent start already created (#504).
    client_request_id TEXT,
    -- The members of a parallel-variant group (spec 010).
    group_id TEXT,
    -- A materialized worktree directory (the path, unless retention reclaimed it): worktree
    -- retention, the worktrees panel and the owned-worker resource collision check.
    worktree_path TEXT,
    -- The branch the run owns: branch cleanup, git-log attribution and the collision check.
    branch TEXT,
    -- Where that branch forked, which branch cleanup reads with it.
    base_branch TEXT,
    -- The commit that last wrote the row: one database-wide sequence (meta 'commit-seq'), so a
    -- revision is never reused, not even by a row deleted and created again under the same id.
    -- A writer compares it with the revision it last read to tell whether the row changed under it.
    revision INTEGER NOT NULL,
    -- The complete record JSON, opaque here.
    data TEXT NOT NULL,
    -- The record's toRunSummary() JSON, so list routes never decode data.
    summary TEXT NOT NULL
  ) STRICT;
  -- (created_at, id) rather than created_at alone: the newest-first reads order by both, and the
  -- second column is what lets SQLite walk the index instead of sorting the tie groups.
  CREATE INDEX runs_created_at ON runs (created_at, id);
  CREATE INDEX runs_status ON runs (status);
  -- Partial indexes: each query asks for the rows that HAVE the value, and most rows do not.
  CREATE INDEX runs_live ON runs (live) WHERE live = 1;
  CREATE INDEX runs_parent_run_id ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
  CREATE INDEX runs_client_request_id ON runs (client_request_id) WHERE client_request_id IS NOT NULL;
  CREATE INDEX runs_group_id ON runs (group_id) WHERE group_id IS NOT NULL;
  CREATE INDEX runs_worktree_path ON runs (worktree_path) WHERE worktree_path IS NOT NULL;
  CREATE INDEX runs_branch ON runs (branch) WHERE branch IS NOT NULL;
  -- Private key/value metadata: import completion and the two sequences below.
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  -- Cross-process ownership (#779, plan step 3): which RunStore may write a delegation family —
  -- a root and its direct workers, or an ordinary run on its own. Only the holder writes the
  -- family's rows, its NDJSON and its cleanup; everyone else reads them.
  CREATE TABLE run_claims (
    -- The family's root id: parent_run_id for a worker, the run's own id otherwise.
    family TEXT PRIMARY KEY,
    -- The RunStore holding it: a random id per open, so two stores in one process differ.
    session TEXT NOT NULL,
    -- That store's process and the process's start identity, so a reused pid is never taken for
    -- the owner. start_token is NULL only where the platform cannot read one.
    pid INTEGER NOT NULL,
    start_token TEXT,
    -- From meta 'claim-generation', bumped by every acquisition. Every write checks that its
    -- family still carries this store's session and generation.
    generation INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX run_claims_session ON run_claims (session);
  -- Private recovery evidence: a write that found its row changed, created or deleted under it,
  -- or its family's claim gone. Never served; kept for a person to inspect.
  CREATE TABLE run_conflicts (
    seq INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    session TEXT NOT NULL,
    -- changed | created | deleted | claim-lost
    reason TEXT NOT NULL,
    -- The row as the writer last read or wrote it (the original); NULL for a row it created.
    base_revision INTEGER,
    base_data TEXT,
    -- What the writer meant to store; NULL with local_deleted = 1 when it meant to delete it.
    local_data TEXT,
    local_deleted INTEGER NOT NULL,
    -- The row as it stands; NULL when another writer deleted it.
    current_revision INTEGER,
    current_data TEXT
  ) STRICT;
  `,
];

/** What the caller writes for one run. Optional columns may be omitted or null. */
export interface RunRowInput {
  id: string;
  createdAt: string;
  finishedAt?: string | null;
  status: string;
  archived: boolean;
  live: boolean;
  parentRunId?: string | null;
  clientRequestId?: string | null;
  groupId?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  /** The complete record, serialized. */
  data: string;
  /** The record's summary projection, serialized. */
  summary: string;
}

export interface RunRow {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  status: string;
  archived: boolean;
  live: boolean;
  parentRunId: string | null;
  clientRequestId: string | null;
  groupId: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  revision: number;
  data: string;
  summary: string;
}

export interface RunSummaryRow {
  id: string;
  createdAt: string;
  revision: number;
  summary: string;
}

/** What branch cleanup and git-log attribution read about one run, without its record. */
export interface BranchOwnerRow {
  id: string;
  createdAt: string;
  status: string;
  archived: boolean;
  branch: string | null;
  baseBranch: string | null;
  summary: string;
}

export interface RunRevision {
  id: string;
  revision: number;
}

export interface RunDatabaseChanges {
  upserts: readonly RunRowInput[];
  deletes: readonly string[];
  /** Private metadata in the same commit; `null` deletes the key. */
  meta?: Readonly<Record<string, string | null>>;
  /** What must still hold for this writer to commit (#779, plan step 3), checked inside the
   *  transaction before anything is written. A violation throws `RunConflictError`. */
  fence?: RunWriteFence;
  /** Write nothing if this `meta` key is present when the transaction holds the write lock: the
   *  commit comes back `skipped`. How exactly one of two concurrent importers imports (#779, plan
   *  step 4) — a check made before the lock is only a hint. */
  onlyIfMetaAbsent?: string;
  /** Runs inside the transaction after every write, just before COMMIT; throwing rolls it all
   *  back. The last moment a caller can still refuse what it wrote. What it returns is more
   *  private metadata, written in the same commit. */
  beforeCommit?: () => Readonly<Record<string, string>> | void;
}

/** A family a fenced write touches: held at `generation`, or to `take` in that same transaction if
 *  its claim is still exactly as the writer judged it (absent, or a dead owner's) — the claim a
 *  busy database kept the writer from taking before. */
export type RunFenceClaim = { generation: number } | { take: { session: string; generation: number } | null };

export interface RunWriteFence {
  owner: { session: string; pid: number; startToken: string | null };
  /** Each family this change set writes. */
  claims: ReadonlyMap<string, RunFenceClaim>;
  /** Each row it writes or deletes: the revision the writer last saw (`null`: it expects no row),
   *  and the family the row belongs to. */
  rows: ReadonlyMap<string, { revision: number | null; family: string }>;
}

export interface RunDatabaseCommit {
  /** The revision each upserted row now has. */
  revisions: Map<string, number>;
  /** The generation of each claim the fence took. */
  claims: Map<string, number>;
  /** Nothing was written: the `onlyIfMetaAbsent` key was present. */
  skipped: boolean;
}

/** One family's owner in `run_claims`. */
export interface RunClaim {
  family: string;
  session: string;
  pid: number;
  startToken: string | null;
  generation: number;
}

/** A row a fenced write found other than its writer last saw it. */
export interface RunRowConflict {
  id: string;
  reason: 'changed' | 'created' | 'deleted' | 'claim-lost';
  /** The row as it stands, or undefined when another writer deleted it. */
  current: RunRow | undefined;
}

/** One `run_conflicts` row: the original, local and current versions of a conflicted run. */
export interface RunConflictEvidence {
  runId: string;
  reason: RunRowConflict['reason'];
  baseRevision: number | null;
  baseData: string | null;
  localData: string | null;
  localDeleted: boolean;
  currentRevision: number | null;
  currentData: string | null;
}

export type RunDatabaseErrorKind = 'busy' | 'permission' | 'disk-full' | 'corrupt' | 'unsupported-schema' | 'conflict' | 'other';

/** Every failure this module reports. `kind` is the discriminant; the subclasses exist so a
 *  caller can also `instanceof` the one case it handles. */
export class RunDatabaseError extends Error {
  readonly kind: RunDatabaseErrorKind;
  /** SQLite's primary result code, when the failure came from SQLite. */
  readonly sqliteCode: number | undefined;

  constructor(kind: RunDatabaseErrorKind, message: string, options: { sqliteCode?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.kind = kind;
    this.sqliteCode = options.sqliteCode;
  }
}

/** Another connection holds the lock past the busy timeout. Transient: retry later. */
export class RunDatabaseBusyError extends RunDatabaseError {}
/** The file or its directory cannot be opened or written by this user. */
export class RunDatabasePermissionError extends RunDatabaseError {}
/** The disk (or a page-count limit) has no room for the write. */
export class RunDatabaseDiskFullError extends RunDatabaseError {}
/** The file is not a database, or a page is malformed. Never reset by this module. */
export class RunDatabaseCorruptError extends RunDatabaseError {}

/** The database was written by a newer cezar whose schema this build does not know. */
export class RunDatabaseUnsupportedSchemaError extends RunDatabaseError {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super('unsupported-schema', `runs database schema ${found} is newer than this cezar supports (${supported})`);
    this.found = found;
    this.supported = supported;
  }
}

/** A fenced write found rows changed, created or deleted under it, or its claim gone. Nothing was
 *  written. `conflicts` names every such row of the change set, each with its current row. */
export class RunConflictError extends RunDatabaseError {
  readonly conflicts: readonly RunRowConflict[];

  constructor(conflicts: readonly RunRowConflict[]) {
    super('conflict', `runs database: ${conflicts.map((c) => `${c.id} (${c.reason})`).join(', ')} changed under this writer`);
    this.conflicts = conflicts;
  }
}

// SQLite primary result codes (https://sqlite.org/rescode.html). node:sqlite reports the
// EXTENDED code in `errcode`; its low byte is the primary code.
const SQLITE_PERM = 3;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_AUTH = 23;
const SQLITE_NOTADB = 26;

/**
 * Map a node:sqlite error (`code: 'ERR_SQLITE_ERROR'`, numeric `errcode`) to its typed class.
 * Anything that is not a SQLite error — a closed connection, a bad argument — passes through
 * unchanged, because wrapping it would claim a database failure that did not happen.
 *
 * `path`, when given, lets SQLITE_CANTOPEN be told apart: it is a permission problem only when
 * the directory, or the file itself, refuses this user. A missing directory, or a directory where
 * the file should be, is not — and "check your permissions" would send the user the wrong way.
 */
export function toRunDatabaseError(error: unknown, path?: string): unknown {
  if (error instanceof RunDatabaseError) return error;
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== 'ERR_SQLITE_ERROR') return error;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode !== 'number') return error;
  const primary = errcode & 0xff;
  const options = { sqliteCode: primary, cause: error };
  const message = `runs database: ${error.message}`;
  switch (primary) {
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return new RunDatabaseBusyError('busy', message, options);
    case SQLITE_PERM:
    case SQLITE_READONLY:
    case SQLITE_AUTH:
      return new RunDatabasePermissionError('permission', message, options);
    case SQLITE_CANTOPEN:
      return path !== undefined && accessDenied(path)
        ? new RunDatabasePermissionError('permission', message, options)
        : new RunDatabaseError('other', message, options);
    case SQLITE_FULL:
      return new RunDatabaseDiskFullError('disk-full', message, options);
    case SQLITE_CORRUPT:
    case SQLITE_NOTADB:
      return new RunDatabaseCorruptError('corrupt', message, options);
    default:
      return new RunDatabaseError('other', message, options);
  }
}

/** Whether this user is refused read-write access to the database file, or (when the file does
 *  not exist yet) to the directory that would hold it. */
function accessDenied(path: string): boolean {
  const target = existsSync(path) ? path : dirname(path);
  if (!existsSync(target)) return false;
  try {
    accessSync(target, constants.R_OK | constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

/** The 16 bytes every SQLite database file starts with (https://sqlite.org/fileformat.html). */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Refuse a non-empty file that does not start with the SQLite header before SQLite sees it.
 * SQLite would also report it as not a database, but closing that connection deletes the `-wal`
 * and `-shm` files beside it — and those may be the only intact copy of recent commits. An empty
 * file is a valid new database. Anything that is not a regular file is left to SQLite to refuse.
 */
function assertDatabaseHeader(path: string): void {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return;
  const fd = openSync(path, 'r');
  let header: Buffer;
  try {
    header = Buffer.alloc(SQLITE_HEADER.length);
    header = header.subarray(0, readSync(fd, header, 0, header.length, 0));
  } finally {
    closeSync(fd);
  }
  if (header.length === 0 || header.equals(SQLITE_HEADER)) return;
  throw new RunDatabaseCorruptError('corrupt', `runs database: ${path} is not a database`, { sqliteCode: SQLITE_NOTADB });
}

const ROW_COLUMNS = 'id, created_at, finished_at, status, archived, live, parent_run_id, client_request_id, group_id, worktree_path, branch, base_branch, revision, data, summary';
/** Newest first, with a deterministic tie-break: the one order every list read uses. */
const NEWEST_FIRST = 'ORDER BY created_at DESC, id DESC';

type SqlRow = Record<string, unknown>;

function toRunRow(row: SqlRow): RunRow {
  return {
    id: row.id as string,
    createdAt: row.created_at as string,
    finishedAt: row.finished_at as string | null,
    status: row.status as string,
    archived: row.archived === 1,
    live: row.live === 1,
    parentRunId: row.parent_run_id as string | null,
    clientRequestId: row.client_request_id as string | null,
    groupId: row.group_id as string | null,
    worktreePath: row.worktree_path as string | null,
    branch: row.branch as string | null,
    baseBranch: row.base_branch as string | null,
    revision: row.revision as number,
    data: row.data as string,
    summary: row.summary as string,
  };
}

function validateChanges(changes: RunDatabaseChanges): void {
  const upserted = new Set<string>();
  for (const row of changes.upserts) {
    if (upserted.has(row.id)) throw new TypeError(`run ${row.id} is upserted twice in one transaction`);
    upserted.add(row.id);
  }
  for (const id of changes.deletes) {
    if (upserted.has(id)) throw new TypeError(`run ${id} is both upserted and deleted in one transaction`);
  }
}

/** `meta` key of the database-wide commit sequence every upsert stamps as its row's revision. */
const COMMIT_SEQ_KEY = 'commit-seq';
/** `meta` key of the sequence every claim acquisition takes its generation from. */
const CLAIM_GENERATION_KEY = 'claim-generation';
const CLAIM_COLUMNS = 'family, session, pid, start_token, generation';

function toRunClaim(row: SqlRow): RunClaim {
  return {
    family: row.family as string,
    session: row.session as string,
    pid: row.pid as number,
    startToken: row.start_token as string | null,
    generation: row.generation as number,
  };
}

export class RunDatabase {
  private readonly db: DatabaseSync;
  private readonly path: string;
  /** Set by the first statement that reports the file damaged (SQLITE_CORRUPT or NOTADB). */
  private damaged = false;
  private readonly statements: {
    get: StatementSync;
    getMany: StatementSync;
    listSummaries: StatementSync;
    listAll: StatementSync;
    listLive: StatementSync;
    listByParent: StatementSync;
    listWorkerIds: StatementSync;
    listIdsByParent: StatementSync;
    findByClientRequestId: StatementSync;
    listByGroup: StatementSync;
    listWithWorktree: StatementSync;
    findResourceHolders: StatementSync;
    listIds: StatementSync;
    has: StatementSync;
    listRevisions: StatementSync;
    getMeta: StatementSync;
    upsert: StatementSync;
    delete: StatementSync;
    setMeta: StatementSync;
    deleteMeta: StatementSync;
    nextSequence: StatementSync;
    familyOf: StatementSync;
    familyHasLive: StatementSync;
    getClaim: StatementSync;
    getClaims: StatementSync;
    listClaims: StatementSync;
    putClaim: StatementSync;
    releaseClaims: StatementSync;
    releaseSessionClaims: StatementSync;
    listForeignClaimedIds: StatementSync;
    insertConflict: StatementSync;
    listConflicts: StatementSync;
  };

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
    this.statements = {
      get: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs WHERE id = ?`),
      getMany: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs WHERE id IN (SELECT value FROM json_each(?))`),
      listSummaries: db.prepare(`SELECT id, created_at, revision, summary FROM runs ${NEWEST_FIRST} LIMIT ?`),
      listAll: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs ${NEWEST_FIRST}`),
      listLive: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs WHERE live = 1`),
      listByParent: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs WHERE parent_run_id = ? ${NEWEST_FIRST}`),
      listWorkerIds: db.prepare('SELECT id FROM runs WHERE parent_run_id IS NOT NULL'),
      listIdsByParent: db.prepare('SELECT id FROM runs WHERE parent_run_id = ?'),
      findByClientRequestId: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs WHERE client_request_id = ? LIMIT 1`),
      listByGroup: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs WHERE group_id = ?`),
      listWithWorktree: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs WHERE worktree_path IS NOT NULL ORDER BY coalesce(finished_at, created_at) DESC, id DESC`),
      findResourceHolders: db.prepare('SELECT id FROM runs WHERE branch = :branch UNION SELECT id FROM runs WHERE worktree_path = :worktreePath'),
      listIds: db.prepare('SELECT id FROM runs'),
      has: db.prepare('SELECT 1 FROM runs WHERE id = ?'),
      listRevisions: db.prepare('SELECT id, revision FROM runs ORDER BY id'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      upsert: db.prepare(`
        INSERT INTO runs (id, created_at, finished_at, status, archived, live, parent_run_id, client_request_id, group_id,
          worktree_path, branch, base_branch, revision, data, summary)
        VALUES (:id, :createdAt, :finishedAt, :status, :archived, :live, :parentRunId, :clientRequestId, :groupId,
          :worktreePath, :branch, :baseBranch, :revision, :data, :summary)
        ON CONFLICT (id) DO UPDATE SET
          created_at = excluded.created_at, finished_at = excluded.finished_at, status = excluded.status,
          archived = excluded.archived, live = excluded.live, parent_run_id = excluded.parent_run_id,
          client_request_id = excluded.client_request_id, group_id = excluded.group_id,
          worktree_path = excluded.worktree_path, branch = excluded.branch, base_branch = excluded.base_branch,
          revision = excluded.revision, data = excluded.data, summary = excluded.summary`),
      delete: db.prepare('DELETE FROM runs WHERE id = ?'),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
      deleteMeta: db.prepare('DELETE FROM meta WHERE key = ?'),
      nextSequence: db.prepare(`INSERT INTO meta (key, value) VALUES (?, '1')
        ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value`),
      familyOf: db.prepare('SELECT coalesce(parent_run_id, id) AS family FROM runs WHERE id = ?'),
      familyHasLive: db.prepare('SELECT 1 FROM runs WHERE live = 1 AND (id = :family OR parent_run_id = :family) LIMIT 1'),
      getClaim: db.prepare(`SELECT ${CLAIM_COLUMNS} FROM run_claims WHERE family = ?`),
      getClaims: db.prepare(`SELECT ${CLAIM_COLUMNS} FROM run_claims WHERE family IN (SELECT value FROM json_each(?))`),
      listClaims: db.prepare(`SELECT ${CLAIM_COLUMNS} FROM run_claims`),
      putClaim: db.prepare(`INSERT INTO run_claims (family, session, pid, start_token, generation)
        VALUES (:family, :session, :pid, :startToken, :generation)
        ON CONFLICT (family) DO UPDATE SET session = excluded.session, pid = excluded.pid,
          start_token = excluded.start_token, generation = excluded.generation`),
      releaseClaims: db.prepare('DELETE FROM run_claims WHERE session = ? AND family IN (SELECT value FROM json_each(?))'),
      releaseSessionClaims: db.prepare('DELETE FROM run_claims WHERE session = ?'),
      listForeignClaimedIds: db.prepare(`SELECT runs.id AS id, run_claims.family AS family FROM run_claims JOIN runs
        ON runs.id = run_claims.family OR runs.parent_run_id = run_claims.family WHERE run_claims.session <> ?`),
      insertConflict: db.prepare(`INSERT INTO run_conflicts (run_id, detected_at, session, reason, base_revision, base_data,
          local_data, local_deleted, current_revision, current_data)
        VALUES (:runId, :detectedAt, :session, :reason, :baseRevision, :baseData, :localData, :localDeleted,
          :currentRevision, :currentData) RETURNING seq`),
      listConflicts: db.prepare('SELECT * FROM run_conflicts ORDER BY seq'),
    };
  }

  /**
   * Open (creating if absent) the database at `path` and bring its schema up to date. The
   * directory must already exist; creating it is the caller's decision. On any failure the
   * connection is closed and no existing data is deleted or rewritten — but a fresh path may be
   * left holding an empty database (and its WAL), which the next open migrates. A reader that must
   * create nothing uses `openReadOnly`.
   */
  static open(path: string): RunDatabase {
    let db: DatabaseSync | undefined;
    try {
      assertDatabaseHeader(path);
      db = new DatabaseSync(path);
      // busy_timeout first, so every later statement here (including the migration) waits on a
      // concurrent opener instead of failing at once.
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      migrate(db);
      return new RunDatabase(db, path);
    } catch (error) {
      const typed = toRunDatabaseError(error, path);
      if (db && typed instanceof RunDatabaseCorruptError) closeLeavingFiles(db, path);
      else if (db?.isOpen) db.close();
      throw typed;
    }
  }

  /**
   * Open an existing database for reading only: never creates the file, never migrates it, never
   * changes journal mode. Answers `null` when there is nothing this build can read yet — no file,
   * or a file still below the current schema (what a failed first open leaves) — so the caller can
   * fall back to whatever it read before the database existed. A newer schema is still refused.
   *
   * SQLite may create the `-wal`/`-shm` coordination files beside the database; that is the price
   * of seeing a live writer's commits. In a read-only directory with neither file present it
   * cannot, and the open fails as permission denied — deliberately not worked around with
   * `immutable=1`, which would read a stale snapshot without saying so.
   */
  static openReadOnly(path: string): RunDatabase | null {
    if (!existsSync(path)) return null;
    let db: DatabaseSync | undefined;
    try {
      assertDatabaseHeader(path);
      db = new DatabaseSync(path, { readOnly: true });
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const found = readSchemaVersion(db);
      if (found > RUN_DATABASE_SCHEMA_VERSION) throw new RunDatabaseUnsupportedSchemaError(found, RUN_DATABASE_SCHEMA_VERSION);
      if (found < RUN_DATABASE_SCHEMA_VERSION) {
        db.close();
        return null;
      }
      return new RunDatabase(db, path);
    } catch (error) {
      if (db?.isOpen) db.close();
      throw toRunDatabaseError(error, path);
    }
  }

  get(id: string): RunRow | undefined {
    const row = this.run(() => this.statements.get.get(id));
    return row ? toRunRow(row) : undefined;
  }

  /** The rows for `ids` that exist, in no particular order. */
  getMany(ids: readonly string[]): RunRow[] {
    if (ids.length === 0) return [];
    return this.run(() => this.statements.getMany.all(JSON.stringify(ids))).map(toRunRow);
  }

  /** Summaries newest first (`created_at`, then `id`, descending). Archived runs are included,
   *  as every list route includes them. Without a limit, every row. */
  listSummaries(options: { limit?: number } = {}): RunSummaryRow[] {
    const limit = options.limit ?? -1;
    return this.run(() => this.statements.listSummaries.all(limit)).map((row) => ({
      id: row.id as string,
      createdAt: row.created_at as string,
      revision: row.revision as number,
      summary: row.summary as string,
    }));
  }

  /** Every row, newest first (`created_at`, then `id`, descending). */
  listAll(): RunRow[] {
    return this.run(() => this.statements.listAll.all()).map(toRunRow);
  }

  /** The rows `RunStore.open` holds in memory: those whose `live` column is set. */
  listLive(): RunRow[] {
    return this.run(() => this.statements.listLive.all()).map(toRunRow);
  }

  /** The workers of one parent, newest first. */
  listByParent(parentId: string): RunRow[] {
    return this.run(() => this.statements.listByParent.all(parentId)).map(toRunRow);
  }

  /** The ids of one parent's workers, in no particular order, without reading their records. */
  listIdsByParent(parentId: string): string[] {
    return this.run(() => this.statements.listIdsByParent.all(parentId)).map((row) => row.id as string);
  }

  /** The id of every worker row, in no particular order. */
  listWorkerIds(): string[] {
    return this.run(() => this.statements.listWorkerIds.all()).map((row) => row.id as string);
  }

  findByClientRequestId(clientRequestId: string): RunRow | undefined {
    const row = this.run(() => this.statements.findByClientRequestId.get(clientRequestId));
    return row ? toRunRow(row) : undefined;
  }

  /** The members of one variant group, in no particular order. */
  listByGroup(groupId: string): RunRow[] {
    return this.run(() => this.statements.listByGroup.all(groupId)).map(toRunRow);
  }

  /** Rows with a materialized worktree, most recently finished (else created) first. */
  listWithWorktree(): RunRow[] {
    return this.run(() => this.statements.listWithWorktree.all()).map(toRunRow);
  }

  /** The rows matching `where` (by default, every row that owns a branch) as branch owners,
   *  with their summary, in no particular order. Same contract for `where` as `listWhere`. */
  listBranchOwners(where = 'branch IS NOT NULL'): BranchOwnerRow[] {
    const sql = `SELECT id, created_at, status, archived, branch, base_branch, summary FROM runs WHERE ${where}`;
    return this.run(() => this.db.prepare(sql).all()).map((row) => ({
      id: row.id as string,
      createdAt: row.created_at as string,
      status: row.status as string,
      archived: row.archived === 1,
      branch: row.branch as string | null,
      baseBranch: row.base_branch as string | null,
      summary: row.summary as string,
    }));
  }

  /** The ids of the rows that own `branch` or hold a worktree at `worktreePath`. */
  findResourceHolders(resource: { branch: string; worktreePath: string }): string[] {
    return this.run(() => this.statements.findResourceHolders.all(resource)).map((row) => row.id as string);
  }

  /** Every id, in no particular order. */
  listIds(): string[] {
    return this.run(() => this.statements.listIds.all()).map((row) => row.id as string);
  }

  has(id: string): boolean {
    return this.run(() => this.statements.has.get(id)) !== undefined;
  }

  /**
   * Rows matching `where`, newest first — the store's candidate filters (mark all read, archive
   * finished, retention, the reference heal), which combine these columns with `json_extract`
   * over `summary`. `where` is the caller's constant SQL; values go in `params`, never into it.
   * `offset` skips the newest rows first (retention keeps the newest N).
   */
  listWhere(where: string, params: readonly (string | number)[] = [], options: { offset?: number } = {}): RunRow[] {
    const sql = `SELECT ${ROW_COLUMNS} FROM runs WHERE ${where} ${NEWEST_FIRST} LIMIT -1 OFFSET ?`;
    return this.run(() => this.db.prepare(sql).all(...params, options.offset ?? 0)).map(toRunRow);
  }

  /** The id and creation time of each row matching `where`, newest first, read off the
   *  `created_at` index without touching `data` or `summary` (history retention's ranking).
   *  Same contract for `where` as `listWhere`. */
  listKeysWhere(where: string, params: readonly (string | number)[] = []): Array<{ id: string; createdAt: string }> {
    const sql = `SELECT id, created_at FROM runs WHERE ${where} ${NEWEST_FIRST}`;
    return this.run(() => this.db.prepare(sql).all(...params)).map((row) => ({ id: row.id as string, createdAt: row.created_at as string }));
  }

  /** Every id with its revision, ordered by id. */
  listRevisions(): RunRevision[] {
    return this.run(() => this.statements.listRevisions.all()).map((row) => ({
      id: row.id as string,
      revision: row.revision as number,
    }));
  }

  getMeta(key: string): string | undefined {
    const row = this.run(() => this.statements.getMeta.get(key));
    return row ? (row.value as string) : undefined;
  }

  /**
   * The only write of run rows. Deletes, upserts and metadata commit together or not at all: on
   * any failure the transaction is rolled back and the error is rethrown typed, with the database
   * exactly as it was. Every upserted row gets this commit's revision from the database-wide
   * sequence. With a `fence`, nothing is written unless every claim and row is still as the writer
   * last saw it (`RunConflictError` otherwise).
   */
  transaction(changes: RunDatabaseChanges): RunDatabaseCommit {
    validateChanges(changes);
    const revisions = new Map<string, number>();
    let claims = new Map<string, number>();
    let skipped = false;
    this.run(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (changes.onlyIfMetaAbsent !== undefined && this.statements.getMeta.get(changes.onlyIfMetaAbsent) !== undefined) {
          skipped = true;
          this.db.exec('ROLLBACK');
          return;
        }
        if (changes.fence) claims = this.checkFence(changes.fence);
        for (const id of changes.deletes) this.statements.delete.run(id);
        const revision = changes.upserts.length > 0 ? this.nextSequence(COMMIT_SEQ_KEY) : 0;
        for (const row of changes.upserts) {
          this.statements.upsert.run({
            id: row.id,
            createdAt: row.createdAt,
            finishedAt: row.finishedAt ?? null,
            status: row.status,
            archived: row.archived ? 1 : 0,
            live: row.live ? 1 : 0,
            parentRunId: row.parentRunId ?? null,
            clientRequestId: row.clientRequestId ?? null,
            groupId: row.groupId ?? null,
            worktreePath: row.worktreePath ?? null,
            branch: row.branch ?? null,
            baseBranch: row.baseBranch ?? null,
            revision,
            data: row.data,
            summary: row.summary,
          });
          revisions.set(row.id, revision);
        }
        for (const [key, value] of Object.entries(changes.meta ?? {})) {
          if (value === null) this.statements.deleteMeta.run(key);
          else this.statements.setMeta.run(key, value);
        }
        for (const [key, value] of Object.entries(changes.beforeCommit?.() ?? {})) this.statements.setMeta.run(key, value);
        this.db.exec('COMMIT');
      } catch (error) {
        rollback(this.db);
        throw error;
      }
    });
    return { revisions, claims, skipped };
  }

  /** Inside a write transaction: take the claims the fence asks for, then throw `RunConflictError`
   *  naming every row of the fence that is not as its writer last saw it, before anything is
   *  written (the claims taken roll back with it). Returns the claims taken. */
  private checkFence(fence: RunWriteFence): Map<string, number> {
    const lost = new Set<string>();
    const taken = new Map<string, number>();
    for (const [family, expected] of fence.claims) {
      const claim = this.statements.getClaim.get(family);
      if ('generation' in expected) {
        if (!claim || claim.session !== fence.owner.session || claim.generation !== expected.generation) lost.add(family);
        continue;
      }
      const unchanged = expected.take === null ? !claim
        : claim?.session === expected.take.session && claim.generation === expected.take.generation;
      if (!unchanged) { lost.add(family); continue; }
      const generation = this.nextSequence(CLAIM_GENERATION_KEY);
      this.statements.putClaim.run({ family, ...fence.owner, generation });
      taken.set(family, generation);
    }
    const conflicts: RunRowConflict[] = [];
    for (const [id, expected] of fence.rows) {
      const found = this.statements.get.get(id);
      const current = found ? toRunRow(found) : undefined;
      const reason = lost.has(expected.family) ? 'claim-lost'
        : expected.revision === null ? (current ? 'created' : undefined)
          : !current ? 'deleted' : current.revision !== expected.revision ? 'changed' : undefined;
      if (reason) conflicts.push({ id, reason, current });
    }
    if (conflicts.length > 0) throw new RunConflictError(conflicts);
    return taken;
  }

  /** Inside a write transaction: the next value of a database-wide sequence kept in `meta`. */
  private nextSequence(key: string): number {
    return Number(this.statements.nextSequence.get(key)!.value);
  }

  /** The family a stored run belongs to (`parent_run_id`, else its own id), or undefined. */
  familyOf(id: string): string | undefined {
    const row = this.run(() => this.statements.familyOf.get(id));
    return row ? (row.family as string) : undefined;
  }

  /** Whether any row of `family` (its root or a direct worker) is live. */
  familyHasLive(family: string): boolean {
    return this.run(() => this.statements.familyHasLive.get({ family })) !== undefined;
  }

  getClaim(family: string): RunClaim | undefined {
    const row = this.run(() => this.statements.getClaim.get(family));
    return row ? toRunClaim(row) : undefined;
  }

  /** The claims on `families` that exist, by family. */
  getClaims(families: readonly string[]): Map<string, RunClaim> {
    if (families.length === 0) return new Map();
    return new Map(this.run(() => this.statements.getClaims.all(JSON.stringify(families))).map((row) => [row.family as string, toRunClaim(row)]));
  }

  listClaims(): RunClaim[] {
    return this.run(() => this.statements.listClaims.all()).map(toRunClaim);
  }

  /**
   * Take the claims in `take` for `owner`, in one transaction. Each is taken only when its claim
   * is still exactly what the caller judged it to be: absent (`expect: null`) or held by the dead
   * owner it read (same session and generation) — so two takers racing for one family cannot both
   * win. Returns the generation of each claim taken.
   */
  takeClaims(
    owner: { session: string; pid: number; startToken: string | null },
    take: ReadonlyArray<{ family: string; expect: { session: string; generation: number } | null }>,
  ): Map<string, number> {
    const taken = new Map<string, number>();
    if (take.length === 0) return taken;
    this.run(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const { family, expect } of take) {
          const current = this.statements.getClaim.get(family);
          const unchanged = expect === null ? !current
            : current?.session === expect.session && current.generation === expect.generation;
          if (!unchanged) continue;
          const generation = this.nextSequence(CLAIM_GENERATION_KEY);
          this.statements.putClaim.run({ family, ...owner, generation });
          taken.set(family, generation);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        rollback(this.db);
        throw error;
      }
    });
    return taken;
  }

  /** Drop `session`'s claims on `families`, or on everything it holds when omitted. */
  releaseClaims(session: string, families?: readonly string[]): void {
    this.run(() => {
      if (families === undefined) this.statements.releaseSessionClaims.run(session);
      else if (families.length > 0) this.statements.releaseClaims.run(session, JSON.stringify(families));
    });
  }

  /** Every row whose family a session other than `session` claims, live or not, with that family. */
  listForeignClaimedIds(session: string): Array<{ id: string; family: string }> {
    return this.run(() => this.statements.listForeignClaimedIds.all(session)).map((row) => ({ id: row.id as string, family: row.family as string }));
  }

  /** Store conflict evidence in one transaction; returns each entry's `seq`. */
  recordConflicts(session: string, entries: readonly RunConflictEvidence[]): number[] {
    const detectedAt = new Date().toISOString();
    const seqs: number[] = [];
    this.run(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const entry of entries) {
          seqs.push(this.statements.insertConflict.get({ ...entry, session, detectedAt, localDeleted: entry.localDeleted ? 1 : 0 })!.seq as number);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        rollback(this.db);
        throw error;
      }
    });
    return seqs;
  }

  /** Every stored conflict, oldest first (diagnostics and tests). */
  listConflicts(): Array<RunConflictEvidence & { seq: number; session: string; detectedAt: string }> {
    return this.run(() => this.statements.listConflicts.all()).map((row) => ({
      seq: row.seq as number,
      runId: row.run_id as string,
      detectedAt: row.detected_at as string,
      session: row.session as string,
      reason: row.reason as RunRowConflict['reason'],
      baseRevision: row.base_revision as number | null,
      baseData: row.base_data as string | null,
      localData: row.local_data as string | null,
      localDeleted: row.local_deleted === 1,
      currentRevision: row.current_revision as number | null,
      currentData: row.current_data as string | null,
    }));
  }

  /** The connection's effective settings, for diagnostics. */
  pragmas(): { journalMode: string; synchronous: number; busyTimeoutMs: number } {
    return this.run(() => ({
      journalMode: this.db.prepare('PRAGMA journal_mode').get()!.journal_mode as string,
      synchronous: this.db.prepare('PRAGMA synchronous').get()!.synchronous as number,
      busyTimeoutMs: this.db.prepare('PRAGMA busy_timeout').get()!.timeout as number,
    }));
  }

  /** Idempotent: closing a closed database does nothing. Once any statement found the file
   *  damaged, the close leaves every file exactly as it is (`closeLeavingFiles`). */
  close(): void {
    if (this.damaged) closeLeavingFiles(this.db, this.path);
    else if (this.db.isOpen) this.db.close();
  }

  private run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      const typed = toRunDatabaseError(error, this.path);
      if (typed instanceof RunDatabaseCorruptError) this.damaged = true;
      throw typed;
    }
  }
}

/** Connections to a damaged database that could not be closed safely (`closeLeavingFiles`). */
const leftOpen: DatabaseSync[] = [];

/**
 * Close `db` without letting SQLite touch the files of a damaged database. The last connection to
 * close checkpoints the WAL into the database file and then deletes `-wal` and `-shm`: over a
 * malformed page that rewrites the damaged file and removes what may be the only intact copy of
 * the latest commits. A read-only connection opened first keeps a shared lock on the file, so the
 * closing one is not the last and does neither; the read-only one cannot write, so its own close
 * does neither either. Any failure on the way still closes `db` the same guarded way or not at all.
 */
function closeLeavingFiles(db: DatabaseSync, path: string): void {
  if (!db.isOpen) return;
  let guard: DatabaseSync | undefined;
  try {
    guard = new DatabaseSync(path, { readOnly: true });
    // A read takes the shared lock; a WAL database keeps it for as long as the connection is open.
    guard.prepare('PRAGMA user_version').get();
  } catch {
    // Without a guard, leaving the connection open is the only close that changes nothing. Held
    // here so garbage collection cannot close it either; the process lets it go when it exits.
    guard?.close();
    leftOpen.push(db);
    return;
  }
  try {
    db.close();
  } finally {
    guard.close();
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  return db.prepare('PRAGMA user_version').get()!.user_version as number;
}

/**
 * Bring `db` to `RUN_DATABASE_SCHEMA_VERSION`, or refuse a newer one. A current database is only
 * read, never written. The version is re-read inside the write transaction, so two processes
 * opening a fresh file at once cannot both run the same migration.
 */
function migrate(db: DatabaseSync): void {
  const found = readSchemaVersion(db);
  if (found > RUN_DATABASE_SCHEMA_VERSION) throw new RunDatabaseUnsupportedSchemaError(found, RUN_DATABASE_SCHEMA_VERSION);
  if (found === RUN_DATABASE_SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    let version = readSchemaVersion(db);
    if (version > RUN_DATABASE_SCHEMA_VERSION) throw new RunDatabaseUnsupportedSchemaError(version, RUN_DATABASE_SCHEMA_VERSION);
    for (; version < RUN_DATABASE_SCHEMA_VERSION; version++) db.exec(MIGRATIONS[version]!);
    db.exec(`PRAGMA user_version = ${RUN_DATABASE_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

/** Undo an open transaction, if there is one. Never throws: the caller is already handling the
 *  error that got it here, and a failed rollback must not replace that error with its own. SQLite
 *  rolls back by itself on FULL, IOERR and BUSY, which is why "no transaction" is not a failure. */
function rollback(db: DatabaseSync): void {
  try {
    if (db.isTransaction) db.exec('ROLLBACK');
  } catch {
    // The connection is closed or broken; whatever the transaction held is gone with it.
  }
}
