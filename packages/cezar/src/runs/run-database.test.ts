import { chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RUN_DATABASE_SCHEMA_VERSION,
  RUNS_DB_FILE,
  RUNS_IMPORT_COMPLETE_KEY,
  RunDatabase,
  RunDatabaseBusyError,
  RunDatabaseCorruptError,
  RunDatabaseDiskFullError,
  RunDatabaseError,
  RunDatabasePermissionError,
  RunDatabaseUnsupportedSchemaError,
  toRunDatabaseError,
  type RunRowInput,
} from './run-database.ts';

let dir: string;
let path: string;
const open: RunDatabase[] = [];

function openDb(at = path): RunDatabase {
  const db = RunDatabase.open(at);
  open.push(db);
  return db;
}

function row(id: string, overrides: Partial<RunRowInput> = {}): RunRowInput {
  return {
    id,
    createdAt: `2026-10-0${id.length % 9}T00:00:00.000Z`,
    status: 'done',
    archived: false,
    data: JSON.stringify({ id, payload: 'full' }),
    summary: JSON.stringify({ id }),
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-run-db-'));
  path = join(dir, RUNS_DB_FILE);
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe('RunDatabase', () => {
  it('names its file runs.db and opens in WAL mode with the agreed pragmas', () => {
    expect(RUNS_DB_FILE).toBe('runs.db');
    openDb();
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: RUN_DATABASE_SCHEMA_VERSION });
    } finally {
      raw.close();
    }
    // `synchronous` and `busy_timeout` are per-connection, so they are asserted through the
    // module's own connection rather than a second one that would report its own defaults.
    expect(openDb().pragmas()).toEqual({ journalMode: 'wal', synchronous: 1, busyTimeoutMs: 50 });
  });

  it('upserts rows and reads them back one at a time and by ids', () => {
    const db = openDb();
    db.transaction({
      upserts: [
        row('a', { finishedAt: '2026-10-05T01:00:00.000Z', parentRunId: 'p', wakeAt: '2026-10-06T00:00:00.000Z' }),
        row('bb', { archived: true, status: 'failed' }),
      ],
      deletes: [],
    });
    expect(db.get('a')).toEqual({
      id: 'a',
      createdAt: '2026-10-01T00:00:00.000Z',
      finishedAt: '2026-10-05T01:00:00.000Z',
      status: 'done',
      archived: false,
      parentRunId: 'p',
      wakeAt: '2026-10-06T00:00:00.000Z',
      revision: 1,
      data: JSON.stringify({ id: 'a', payload: 'full' }),
      summary: JSON.stringify({ id: 'a' }),
    });
    expect(db.get('bb')).toMatchObject({ archived: true, status: 'failed', finishedAt: null, parentRunId: null, wakeAt: null });
    expect(db.get('missing')).toBeUndefined();
    expect(db.getMany(['bb', 'missing', 'a']).map((r) => r.id).sort()).toEqual(['a', 'bb']);
    expect(db.getMany([])).toEqual([]);
  });

  it('bumps the revision on every upsert of an existing row and reports the new revisions', () => {
    const db = openDb();
    expect(db.transaction({ upserts: [row('a'), row('b')], deletes: [] }).revisions).toEqual(new Map([['a', 1], ['b', 1]]));
    expect(db.transaction({ upserts: [row('a', { status: 'running' })], deletes: [] }).revisions).toEqual(new Map([['a', 2]]));
    db.transaction({ upserts: [row('a')], deletes: [] });
    expect(db.listRevisions()).toEqual([{ id: 'a', revision: 3 }, { id: 'b', revision: 1 }]);
    expect(db.get('a')?.revision).toBe(3);
  });

  it('deletes rows in the same transaction as upserts', () => {
    const db = openDb();
    db.transaction({ upserts: [row('a'), row('b')], deletes: [] });
    db.transaction({ upserts: [row('c')], deletes: ['a', 'never-existed'] });
    expect(db.listRevisions().map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('commits all-or-nothing: a failing statement mid-transaction changes no row', () => {
    const db = openDb();
    db.transaction({ upserts: [row('a'), row('b')], deletes: [], meta: { importedAt: 'before' } });
    const before = { a: db.get('a'), b: db.get('b'), revisions: db.listRevisions(), meta: db.getMeta('importedAt') };

    // The second upsert violates NOT NULL, after a delete and a successful upsert already ran.
    const broken = { ...row('c'), status: null } as unknown as RunRowInput;
    expect(() => db.transaction({
      upserts: [row('a', { status: 'running' }), broken],
      deletes: ['b'],
      meta: { importedAt: 'after' },
    })).toThrow(RunDatabaseError);

    expect({ a: db.get('a'), b: db.get('b'), revisions: db.listRevisions(), meta: db.getMeta('importedAt') }).toEqual(before);
    expect(db.get('c')).toBeUndefined();
    // The connection is usable again: the failed transaction was rolled back, not left open.
    db.transaction({ upserts: [row('c')], deletes: [] });
    expect(db.get('c')?.revision).toBe(1);
  });

  it('refuses a change set that both upserts and deletes one id, or upserts it twice', () => {
    const db = openDb();
    expect(() => db.transaction({ upserts: [row('a')], deletes: ['a'] })).toThrow(/both upserted and deleted/);
    expect(() => db.transaction({ upserts: [row('a'), row('a')], deletes: [] })).toThrow(/upserted twice/);
    expect(db.listRevisions()).toEqual([]);
  });

  it('lists summaries newest first, capped at N, with a deterministic tie-break', () => {
    const db = openDb();
    db.transaction({
      upserts: [
        row('old', { createdAt: '2026-01-01T00:00:00.000Z' }),
        row('new', { createdAt: '2026-03-01T00:00:00.000Z', archived: true }),
        row('mid-a', { createdAt: '2026-02-01T00:00:00.000Z' }),
        row('mid-b', { createdAt: '2026-02-01T00:00:00.000Z' }),
      ],
      deletes: [],
    });
    expect(db.listSummaries().map((s) => s.id)).toEqual(['new', 'mid-b', 'mid-a', 'old']);
    expect(db.listSummaries({ limit: 2 })).toEqual([
      { id: 'new', createdAt: '2026-03-01T00:00:00.000Z', revision: 1, summary: JSON.stringify({ id: 'new' }) },
      { id: 'mid-b', createdAt: '2026-02-01T00:00:00.000Z', revision: 1, summary: JSON.stringify({ id: 'mid-b' }) },
    ]);
  });

  it('serves the newest-first summary read from one index, without a sort step', () => {
    openDb();
    const raw = new DatabaseSync(path);
    try {
      const plan = raw.prepare('EXPLAIN QUERY PLAN SELECT id, created_at, revision, summary FROM runs ORDER BY created_at DESC, id DESC LIMIT 201')
        .all().map((step) => String(step.detail));
      expect(plan).toEqual(['SCAN runs USING INDEX runs_created_at']);
    } finally {
      raw.close();
    }
  });

  it('lists every row newest first', () => {
    const db = openDb();
    db.transaction({
      upserts: [
        row('old', { createdAt: '2026-01-01T00:00:00.000Z' }),
        row('new', { createdAt: '2026-03-01T00:00:00.000Z' }),
        row('mid', { createdAt: '2026-02-01T00:00:00.000Z' }),
      ],
      deletes: [],
    });
    expect(db.listAll().map((r) => [r.id, r.data])).toEqual([
      ['new', JSON.stringify({ id: 'new', payload: 'full' })],
      ['mid', JSON.stringify({ id: 'mid', payload: 'full' })],
      ['old', JSON.stringify({ id: 'old', payload: 'full' })],
    ]);
  });

  it('stores private metadata through the transaction and deletes it with null', () => {
    const db = openDb();
    expect(db.getMeta('import')).toBeUndefined();
    db.transaction({ upserts: [], deletes: [], meta: { import: 'complete', owner: 'x' } });
    db.transaction({ upserts: [], deletes: [], meta: { owner: null } });
    expect(db.getMeta('import')).toBe('complete');
    expect(db.getMeta('owner')).toBeUndefined();
  });

  it('persists across close and reopen', () => {
    const first = RunDatabase.open(path);
    first.transaction({ upserts: [row('a'), row('b')], deletes: [], meta: { import: 'complete' } });
    first.transaction({ upserts: [row('a', { status: 'cancelled' })], deletes: ['b'] });
    first.close();

    const second = openDb();
    expect(second.get('a')).toMatchObject({ status: 'cancelled', revision: 2 });
    expect(second.get('b')).toBeUndefined();
    expect(second.getMeta('import')).toBe('complete');
  });

  it('closes idempotently', () => {
    const db = RunDatabase.open(path);
    db.close();
    expect(() => db.close()).not.toThrow();
  });

  it('creates the schema once and leaves a current database untouched on reopen', () => {
    RunDatabase.open(path).close();
    const db = openDb();
    expect(db.listRevisions()).toEqual([]);
  });

  describe('errors', () => {
    it('reports a newer schema version as unsupported and leaves the file alone', () => {
      RunDatabase.open(path).close();
      const raw = new DatabaseSync(path);
      raw.exec(`PRAGMA user_version = ${RUN_DATABASE_SCHEMA_VERSION + 1}`);
      raw.close();
      const bytes = readFileSync(path);

      let caught: unknown;
      try { openDb(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(RunDatabaseUnsupportedSchemaError);
      expect(caught).toBeInstanceOf(RunDatabaseError);
      expect(caught).toMatchObject({ kind: 'unsupported-schema', found: RUN_DATABASE_SCHEMA_VERSION + 1, supported: RUN_DATABASE_SCHEMA_VERSION });
      expect(readFileSync(path).equals(bytes)).toBe(true);
    });

    it('reports a file that is not a database as corrupt and never deletes or resets it', () => {
      const garbage = Buffer.from('not a sqlite database '.repeat(400));
      writeFileSync(path, garbage);

      expect(() => openDb()).toThrow(RunDatabaseCorruptError);
      expect(readFileSync(path).equals(garbage)).toBe(true);
    });

    it('reports a malformed page as corrupt and leaves the database file in place', () => {
      const db = RunDatabase.open(path);
      db.transaction({ upserts: Array.from({ length: 200 }, (_, i) => row(`run-${i}`, { data: 'x'.repeat(500) })), deletes: [] });
      db.close();
      const fd = openSync(path, 'r+');
      writeSync(fd, Buffer.alloc(4096 * 3, 0xab), 0, 4096 * 3, 4096);
      closeSync(fd);
      const bytes = readFileSync(path);

      let caught: unknown;
      try { openDb().listSummaries(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(RunDatabaseCorruptError);
      expect(caught).toMatchObject({ kind: 'corrupt', sqliteCode: 11 });
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect(readdirSync(dir)).toContain(RUNS_DB_FILE);
    });

    it('reports a write blocked by another connection as busy after the busy timeout', () => {
      const db = openDb();
      const other = new DatabaseSync(path);
      other.exec('BEGIN IMMEDIATE');
      try {
        const started = performance.now();
        let caught: unknown;
        try { db.transaction({ upserts: [row('a')], deletes: [] }); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(RunDatabaseBusyError);
        expect(caught).toMatchObject({ kind: 'busy', sqliteCode: 5 });
        expect(performance.now() - started).toBeGreaterThanOrEqual(40);
      } finally {
        other.exec('ROLLBACK');
        other.close();
      }
      // Contention is transient: once the other writer lets go, the same change commits.
      db.transaction({ upserts: [row('a')], deletes: [] });
      expect(db.get('a')?.revision).toBe(1);
    });

    it('leaves a corrupt database and its WAL and SHM files exactly as found', () => {
      const files = { [RUNS_DB_FILE]: 'not a database '.repeat(300), [`${RUNS_DB_FILE}-wal`]: 'wal '.repeat(300), [`${RUNS_DB_FILE}-shm`]: 'shm '.repeat(300) };
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);

      expect(() => openDb()).toThrow(RunDatabaseCorruptError);
      for (const [name, text] of Object.entries(files)) expect(readFileSync(join(dir, name), 'utf8')).toBe(text);
    });

    it('does not report a path it cannot open for another reason as permission denied', () => {
      // An existing, writable directory where the database file should be: SQLITE_CANTOPEN, and
      // telling the user to fix permissions would send them looking in the wrong place.
      mkdirSync(path);
      let caught: unknown;
      try { openDb(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(RunDatabaseError);
      expect(caught).not.toBeInstanceOf(RunDatabasePermissionError);
      expect(caught).toMatchObject({ kind: 'other', sqliteCode: 14 });
    });

    it('keeps the original error when the rollback after it fails too', () => {
      const db = RunDatabase.open(path);
      // Closing the connection mid-transaction makes the upsert fail, and then the rollback has
      // no connection left to run on. The caller must learn about the first failure, not the second.
      const closing = { ...row('a'), get summary() { db.close(); return '{}'; } };
      expect(() => db.transaction({ upserts: [closing], deletes: [] })).toThrow('statement has been finalized');
    });

    it.skipIf(process.getuid?.() === 0)('reports a read-only data directory as permission denied', () => {
      chmodSync(dir, 0o555);
      expect(() => openDb()).toThrow(RunDatabasePermissionError);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('reports a database that cannot grow as disk full', () => {
      // A real SQLITE_FULL from node:sqlite, provoked on a raw connection capped at three pages:
      // filling a disk is not something a unit test can do, but the error shape is what matters.
      const raw = new DatabaseSync(':memory:');
      raw.exec('CREATE TABLE t(v TEXT); PRAGMA max_page_count = 3');
      let sqliteError: unknown;
      try {
        for (let i = 0; i < 10; i++) raw.prepare('INSERT INTO t VALUES (?)').run('y'.repeat(4000));
      } catch (error) {
        sqliteError = error;
      } finally {
        raw.close();
      }
      const mapped = toRunDatabaseError(sqliteError);
      expect(mapped).toBeInstanceOf(RunDatabaseDiskFullError);
      expect(mapped).toMatchObject({ kind: 'disk-full', sqliteCode: 13, cause: sqliteError });
    });

    it('maps extended result codes by their primary code and passes non-sqlite errors through', () => {
      const sqlite = (errcode: number) => Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'x' });
      expect(toRunDatabaseError(sqlite(517))).toBeInstanceOf(RunDatabaseBusyError); // SQLITE_BUSY_SNAPSHOT
      expect(toRunDatabaseError(sqlite(6))).toBeInstanceOf(RunDatabaseBusyError); // SQLITE_LOCKED
      expect(toRunDatabaseError(sqlite(8))).toBeInstanceOf(RunDatabasePermissionError); // SQLITE_READONLY
      expect(toRunDatabaseError(sqlite(3))).toBeInstanceOf(RunDatabasePermissionError); // SQLITE_PERM
      expect(toRunDatabaseError(sqlite(26))).toBeInstanceOf(RunDatabaseCorruptError); // SQLITE_NOTADB
      const other = toRunDatabaseError(sqlite(19)); // SQLITE_CONSTRAINT
      expect(other).toBeInstanceOf(RunDatabaseError);
      expect(other).toMatchObject({ kind: 'other', sqliteCode: 19 });
      const plain = new TypeError('not sqlite');
      expect(toRunDatabaseError(plain)).toBe(plain);
    });
  });

  describe('read-only open', () => {
    it('reads rows, summaries and metadata without being able to write', () => {
      const writer = openDb();
      writer.transaction({ upserts: [row('a'), row('bb')], deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: '{}' } });
      const reader = RunDatabase.openReadOnly(path)!;
      open.push(reader);
      expect(reader.get('a')?.id).toBe('a');
      expect(reader.listSummaries({ limit: 1 }).map((s) => s.id)).toHaveLength(1);
      expect(reader.getMeta(RUNS_IMPORT_COMPLETE_KEY)).toBe('{}');
      expect(() => reader.transaction({ upserts: [row('c')], deletes: [] })).toThrow(RunDatabasePermissionError);
      expect(writer.get('c')).toBeUndefined();
    });

    it('answers null for a missing file and creates nothing', () => {
      expect(RunDatabase.openReadOnly(path)).toBeNull();
      expect(readdirSync(dir)).toEqual([]);
    });

    it('answers null for a database this build has not migrated yet, and does not migrate it', () => {
      // A zero-byte file is an empty SQLite database at schema 0: what a failed first open leaves.
      writeFileSync(path, '');
      expect(RunDatabase.openReadOnly(path)).toBeNull();
      const raw = new DatabaseSync(path);
      try {
        expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
        expect(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
      } finally {
        raw.close();
      }
    });

    it('refuses a newer schema', () => {
      RunDatabase.open(path).close();
      const raw = new DatabaseSync(path);
      raw.exec(`PRAGMA user_version = ${RUN_DATABASE_SCHEMA_VERSION + 1}`);
      raw.close();
      expect(() => RunDatabase.openReadOnly(path)).toThrow(RunDatabaseUnsupportedSchemaError);
    });

    it.skipIf(process.getuid?.() === 0)('reads a read-only directory while a writer keeps the WAL open, creating nothing', () => {
      const writer = openDb();
      writer.transaction({ upserts: [row('a')], deletes: [] });
      const before = readdirSync(dir).sort();
      chmodSync(dir, 0o555);
      const reader = RunDatabase.openReadOnly(path)!;
      open.push(reader);
      expect(reader.get('a')?.id).toBe('a');
      expect(readdirSync(dir).sort()).toEqual(before);
    });

    it.skipIf(process.getuid?.() === 0)('fails typed, creating nothing, in a read-only directory with no WAL to read through', () => {
      const writer = RunDatabase.open(path);
      writer.transaction({ upserts: [row('a')], deletes: [] });
      writer.close();
      chmodSync(dir, 0o555);
      // SQLite cannot build the WAL index without creating the -shm file. Opening the database
      // immutable would read it anyway, but would also miss a writer's later commits.
      expect(() => RunDatabase.openReadOnly(path)).toThrow(RunDatabasePermissionError);
      expect(readdirSync(dir)).toEqual([RUNS_DB_FILE]);
    });
  });
});
