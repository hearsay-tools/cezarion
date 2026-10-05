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
  -- copies of record fields, kept in step by the caller in the same transaction as data.
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    -- Newest-first order: GET /run-summaries, /workspace/runs-index and the cold newest-200 read.
    created_at TEXT NOT NULL,
    -- Retention: how long ago a finished run finished (falls back to created_at in the caller).
    finished_at TEXT,
    -- The live set (queued/running/waiting) and open-time recovery of interrupted runs.
    status TEXT NOT NULL,
    -- Retention and the bulk-archive sweep skip or select archived runs (0/1).
    archived INTEGER NOT NULL,
    -- The workers of a parent (delegation.parentRunId), replacing whole-map scans.
    parent_run_id TEXT,
    -- The live set's "a wake timer or autoResumeAt is pending" clause: the earliest pending wake.
    wake_at TEXT,
    -- Bumped by every upsert; lets a reader tell which rows changed since it last looked.
    revision INTEGER NOT NULL,
    -- The complete record JSON, opaque here.
    data TEXT NOT NULL,
    -- The record's toRunSummary() JSON, so list routes never decode data.
    summary TEXT NOT NULL
  ) STRICT;
  -- (created_at, id) rather than created_at alone: the newest-first reads order by both, and the
  -- second column is what lets SQLite walk the index instead of sorting the tie groups.
  CREATE INDEX runs_created_at ON runs (created_at, id);
  CREATE INDEX runs_parent_run_id ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
  CREATE INDEX runs_status ON runs (status);
  CREATE INDEX runs_wake_at ON runs (wake_at) WHERE wake_at IS NOT NULL;
  -- Private key/value metadata: import completion, ownership claims, conflict evidence.
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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
  parentRunId?: string | null;
  wakeAt?: string | null;
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
  parentRunId: string | null;
  wakeAt: string | null;
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

export interface RunRevision {
  id: string;
  revision: number;
}

export interface RunDatabaseChanges {
  upserts: readonly RunRowInput[];
  deletes: readonly string[];
  /** Private metadata in the same commit; `null` deletes the key. */
  meta?: Readonly<Record<string, string | null>>;
}

export interface RunDatabaseCommit {
  /** The revision each upserted row now has. */
  revisions: Map<string, number>;
}

export type RunDatabaseErrorKind = 'busy' | 'permission' | 'disk-full' | 'corrupt' | 'unsupported-schema' | 'other';

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

const ROW_COLUMNS = 'id, created_at, finished_at, status, archived, parent_run_id, wake_at, revision, data, summary';

type SqlRow = Record<string, unknown>;

function toRunRow(row: SqlRow): RunRow {
  return {
    id: row.id as string,
    createdAt: row.created_at as string,
    finishedAt: row.finished_at as string | null,
    status: row.status as string,
    archived: row.archived === 1,
    parentRunId: row.parent_run_id as string | null,
    wakeAt: row.wake_at as string | null,
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

export class RunDatabase {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly statements: {
    get: StatementSync;
    getMany: StatementSync;
    listSummaries: StatementSync;
    listAll: StatementSync;
    listRevisions: StatementSync;
    getMeta: StatementSync;
    upsert: StatementSync;
    delete: StatementSync;
    setMeta: StatementSync;
    deleteMeta: StatementSync;
  };

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
    this.statements = {
      get: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs WHERE id = ?`),
      getMany: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs WHERE id IN (SELECT value FROM json_each(?))`),
      listSummaries: db.prepare('SELECT id, created_at, revision, summary FROM runs ORDER BY created_at DESC, id DESC LIMIT ?'),
      listAll: db.prepare(`SELECT ${ROW_COLUMNS} FROM runs ORDER BY created_at DESC, id DESC`),
      listRevisions: db.prepare('SELECT id, revision FROM runs ORDER BY id'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      upsert: db.prepare(`
        INSERT INTO runs (id, created_at, finished_at, status, archived, parent_run_id, wake_at, revision, data, summary)
        VALUES (:id, :createdAt, :finishedAt, :status, :archived, :parentRunId, :wakeAt, 1, :data, :summary)
        ON CONFLICT (id) DO UPDATE SET
          created_at = excluded.created_at, finished_at = excluded.finished_at, status = excluded.status,
          archived = excluded.archived, parent_run_id = excluded.parent_run_id, wake_at = excluded.wake_at,
          revision = runs.revision + 1, data = excluded.data, summary = excluded.summary
        RETURNING revision`),
      delete: db.prepare('DELETE FROM runs WHERE id = ?'),
      setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
      deleteMeta: db.prepare('DELETE FROM meta WHERE key = ?'),
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
      if (db?.isOpen) db.close();
      throw toRunDatabaseError(error, path);
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
   * The only write. Deletes, upserts and metadata commit together or not at all: on any failure
   * the transaction is rolled back and the error is rethrown typed, with the database exactly as
   * it was. Each upsert bumps the row's revision (a new row starts at 1).
   */
  transaction(changes: RunDatabaseChanges): RunDatabaseCommit {
    validateChanges(changes);
    const revisions = new Map<string, number>();
    this.run(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of changes.deletes) this.statements.delete.run(id);
        for (const row of changes.upserts) {
          const written = this.statements.upsert.get({
            id: row.id,
            createdAt: row.createdAt,
            finishedAt: row.finishedAt ?? null,
            status: row.status,
            archived: row.archived ? 1 : 0,
            parentRunId: row.parentRunId ?? null,
            wakeAt: row.wakeAt ?? null,
            data: row.data,
            summary: row.summary,
          });
          revisions.set(row.id, written!.revision as number);
        }
        for (const [key, value] of Object.entries(changes.meta ?? {})) {
          if (value === null) this.statements.deleteMeta.run(key);
          else this.statements.setMeta.run(key, value);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        rollback(this.db);
        throw error;
      }
    });
    return { revisions };
  }

  /** The connection's effective settings, for diagnostics. */
  pragmas(): { journalMode: string; synchronous: number; busyTimeoutMs: number } {
    return this.run(() => ({
      journalMode: this.db.prepare('PRAGMA journal_mode').get()!.journal_mode as string,
      synchronous: this.db.prepare('PRAGMA synchronous').get()!.synchronous as number,
      busyTimeoutMs: this.db.prepare('PRAGMA busy_timeout').get()!.timeout as number,
    }));
  }

  /** Idempotent: closing a closed database does nothing. */
  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw toRunDatabaseError(error, this.path);
    }
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
