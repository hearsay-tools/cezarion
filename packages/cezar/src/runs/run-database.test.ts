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
  RunConflictError,
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
    live: false,
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
        row('a', {
          finishedAt: '2026-10-05T01:00:00.000Z', parentRunId: 'p', live: true, clientRequestId: 'req-1', groupId: 'g',
          worktreePath: '/repo/.ai/cezar/worktrees/a', branch: 'cez/a', baseBranch: 'main',
        }),
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
      live: true,
      parentRunId: 'p',
      clientRequestId: 'req-1',
      groupId: 'g',
      worktreePath: '/repo/.ai/cezar/worktrees/a',
      branch: 'cez/a',
      baseBranch: 'main',
      revision: 1,
      data: JSON.stringify({ id: 'a', payload: 'full' }),
      summary: JSON.stringify({ id: 'a' }),
    });
    expect(db.get('bb')).toMatchObject({
      archived: true, status: 'failed', live: false, finishedAt: null, parentRunId: null, clientRequestId: null,
      groupId: null, worktreePath: null, branch: null, baseBranch: null,
    });
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
    // The connection is usable again: the failed transaction was rolled back, not left open —
    // its revision too, so the next commit takes the one after the last that committed.
    db.transaction({ upserts: [row('c')], deletes: [] });
    expect(db.get('c')?.revision).toBe(2);
  });

  it('never reuses a revision, not even for a row deleted and created again under its id (#779)', () => {
    const db = openDb();
    db.transaction({ upserts: [row('a')], deletes: [] });
    const first = db.get('a')!.revision;
    db.transaction({ upserts: [], deletes: ['a'] });
    db.transaction({ upserts: [row('a', { status: 'running' })], deletes: [] });
    // Per-row counters restarted at 1 here, so (id, revision) named two different rows over time.
    expect(db.get('a')!.revision).toBeGreaterThan(first);
    expect(db.transaction({ upserts: [row('b')], deletes: [] }).revisions.get('b')).toBeGreaterThan(db.get('a')!.revision);
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

  describe('claims and fenced writes (#779, plan step 3)', () => {
    const owner = (session: string) => ({ session, pid: 4242, startToken: 'boot:1' });

    it('takes absent claims and dead owners\' claims only while they are as the taker read them', () => {
      const db = openDb();
      const first = db.takeClaims(owner('s1'), [{ family: 'f1', expect: null }, { family: 'f2', expect: null }]);
      expect([...first.keys()]).toEqual(['f1', 'f2']);
      expect(first.get('f2')).toBeGreaterThan(first.get('f1')!);
      // A second taker that also read "absent" loses: the claim is no longer what it judged.
      expect(db.takeClaims(owner('s2'), [{ family: 'f1', expect: null }]).size).toBe(0);
      // Taking over from the owner read (judged dead elsewhere) works once, with a new generation.
      const held = db.getClaim('f1')!;
      const taken = db.takeClaims(owner('s2'), [{ family: 'f1', expect: { session: held.session, generation: held.generation } }]);
      expect(taken.get('f1')).toBeGreaterThan(first.get('f2')!);
      expect(db.getClaim('f1')).toEqual({ family: 'f1', session: 's2', pid: 4242, startToken: 'boot:1', generation: taken.get('f1') });
      expect(db.takeClaims(owner('s3'), [{ family: 'f1', expect: { session: held.session, generation: held.generation } }]).size).toBe(0);
    });

    it('releases one session\'s claims, by family or all at once, and never another\'s', () => {
      const db = openDb();
      db.takeClaims(owner('s1'), [{ family: 'a', expect: null }, { family: 'b', expect: null }]);
      db.takeClaims(owner('s2'), [{ family: 'c', expect: null }]);
      db.releaseClaims('s1', ['a', 'c']);
      expect(db.listClaims().map((c) => c.family).sort()).toEqual(['b', 'c']);
      db.releaseClaims('s1');
      expect(db.listClaims().map((c) => c.family)).toEqual(['c']);
    });

    it('names a family and whether anything in it is live, and the rows other sessions claim', () => {
      const db = openDb();
      db.transaction({ upserts: [row('root', { live: false }), row('w1', { parentRunId: 'root', live: true }), row('solo')], deletes: [] });
      expect(db.familyOf('w1')).toBe('root');
      expect(db.familyOf('root')).toBe('root');
      expect(db.familyOf('missing')).toBeUndefined();
      expect(db.familyHasLive('root')).toBe(true);
      expect(db.familyHasLive('solo')).toBe(false);
      db.takeClaims(owner('mine'), [{ family: 'solo', expect: null }]);
      db.takeClaims(owner('theirs'), [{ family: 'root', expect: null }]);
      expect(db.listForeignClaimedIds('mine').map((row) => `${row.id}:${row.family}`).sort()).toEqual(['root:root', 'w1:root']);
    });

    it('commits a fenced write only while its claims and rows are as the writer last saw them', () => {
      const db = openDb();
      const generation = db.takeClaims(owner('s1'), [{ family: 'a', expect: null }]).get('a')!;
      db.transaction({ upserts: [row('a')], deletes: [] });
      const seen = db.get('a')!.revision;
      const fence = (revision: number | null, gen = generation) => ({
        owner: owner('s1'), claims: new Map([['a', { generation: gen }]]), rows: new Map([['a', { revision, family: 'a' }]]),
      });
      // As seen: commits.
      db.transaction({ upserts: [row('a', { status: 'running' })], deletes: [], fence: fence(seen) });
      const now = db.get('a')!;
      // A stale revision, a stale generation, or "expected absent" over a real row: nothing is written.
      for (const [stale, reason] of [[fence(seen), 'changed'], [fence(now.revision, generation + 99), 'claim-lost'], [fence(null), 'created']] as const) {
        let caught: unknown;
        try { db.transaction({ upserts: [row('a', { status: 'failed' })], deletes: [], meta: { touched: 'yes' }, fence: stale }); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(RunConflictError);
        expect((caught as RunConflictError).kind).toBe('conflict');
        expect((caught as RunConflictError).conflicts).toEqual([{ id: 'a', reason, current: now }]);
      }
      expect(db.get('a')).toEqual(now);
      expect(db.getMeta('touched')).toBeUndefined();
      // Deleted under the writer.
      db.transaction({ upserts: [], deletes: ['a'] });
      expect(() => db.transaction({ upserts: [], deletes: ['a'], fence: fence(now.revision) })).toThrow(expect.objectContaining({
        conflicts: [{ id: 'a', reason: 'deleted', current: undefined }],
      }));
    });

    it('takes a claim inside the write that needs it, only while it is as the writer judged it', () => {
      const db = openDb();
      const take = (expect: { session: string; generation: number } | null) => ({
        owner: owner('s1'), claims: new Map([['a', { take: expect }]]), rows: new Map([['a', { revision: null, family: 'a' }]]),
      });
      const commit = db.transaction({ upserts: [row('a')], deletes: [], fence: take(null) });
      expect(commit.claims.get('a')).toBe(db.getClaim('a')!.generation);
      expect(db.getClaim('a')).toMatchObject({ session: 's1' });
      // Someone took it after the writer judged it absent: nothing is written, no claim changes.
      db.releaseClaims('s1');
      db.takeClaims(owner('s2'), [{ family: 'a', expect: null }]);
      const before = db.getClaim('a');
      expect(() => db.transaction({ upserts: [row('a', { status: 'failed' })], deletes: [], fence: { ...take(null), rows: new Map([['a', { revision: db.get('a')!.revision, family: 'a' }]]) } }))
        .toThrow(expect.objectContaining({ conflicts: [expect.objectContaining({ id: 'a', reason: 'claim-lost' })] }));
      expect(db.getClaim('a')).toEqual(before);
      expect(db.get('a')?.status).toBe('done');
    });

    it('stores conflict evidence and lists it back', () => {
      const db = openDb();
      const [seq] = db.recordConflicts('s1', [{ runId: 'a', reason: 'changed', baseRevision: 1, baseData: '{"v":1}', localData: '{"v":2}',
        localDeleted: false, currentRevision: 3, currentData: '{"v":3}' }]);
      expect(db.listConflicts()).toEqual([expect.objectContaining({ seq, runId: 'a', session: 's1', reason: 'changed', baseRevision: 1,
        baseData: '{"v":1}', localData: '{"v":2}', localDeleted: false, currentRevision: 3, currentData: '{"v":3}' })]);
    });
  });

  describe('named queries', () => {
    // Each query reads one column the caller computed; the rows are seeded with the column set or
    // not, so a query that ignored its column (or read another) returns the wrong ids.
    function seed(db: RunDatabase): void {
      db.transaction({
        upserts: [
          row('live-1', { createdAt: '2026-10-03T00:00:00.000Z', status: 'running', live: true }),
          row('live-2', { createdAt: '2026-10-04T00:00:00.000Z', status: 'failed', live: true }),
          row('done-1', { createdAt: '2026-10-01T00:00:00.000Z' }),
          row('w-1', { createdAt: '2026-10-02T00:00:00.000Z', parentRunId: 'root-1', branch: 'cez/w-1' }),
          row('w-2', { createdAt: '2026-10-05T00:00:00.000Z', parentRunId: 'root-1' }),
          row('w-3', { createdAt: '2026-10-06T00:00:00.000Z', parentRunId: 'root-2' }),
          row('req', { clientRequestId: 'client-1' }),
          row('v-a', { createdAt: '2026-10-07T00:00:00.000Z', groupId: 'group-1' }),
          row('v-b', { createdAt: '2026-10-07T00:00:00.000Z', groupId: 'group-1' }),
          row('tree-old', { finishedAt: '2026-10-01T00:00:00.000Z', worktreePath: '/w/old', branch: 'cez/old', baseBranch: 'main' }),
          row('tree-new', { createdAt: '2026-10-02T00:00:00.000Z', worktreePath: '/w/new', branch: 'cez/new' }),
        ],
        deletes: [],
      });
    }

    it('lists the live rows', () => {
      const db = openDb();
      seed(db);
      expect(db.listLive().map((r) => r.id).sort()).toEqual(['live-1', 'live-2']);
    });

    it("lists a parent's workers newest first, and every worker id", () => {
      const db = openDb();
      seed(db);
      expect(db.listByParent('root-1').map((r) => r.id)).toEqual(['w-2', 'w-1']);
      expect(db.listByParent('nobody')).toEqual([]);
      expect(db.listIdsByParent('root-1').sort()).toEqual(['w-1', 'w-2']);
      expect(db.listWorkerIds().sort()).toEqual(['w-1', 'w-2', 'w-3']);
    });

    it('finds a run by its client request id', () => {
      const db = openDb();
      seed(db);
      expect(db.findByClientRequestId('client-1')?.id).toBe('req');
      expect(db.findByClientRequestId('client-2')).toBeUndefined();
    });

    it("lists a variant group's members", () => {
      const db = openDb();
      seed(db);
      expect(db.listByGroup('group-1').map((r) => r.id).sort()).toEqual(['v-a', 'v-b']);
      expect(db.listByGroup('group-2')).toEqual([]);
    });

    it('lists runs with a materialized worktree, most recently finished first', () => {
      const db = openDb();
      seed(db);
      // tree-new never finished, so it ranks by when it was created — after tree-old finished.
      expect(db.listWithWorktree().map((r) => r.id)).toEqual(['tree-new', 'tree-old']);
    });

    it('lists the branch owners with their summary, and the rows holding a branch or checkout', () => {
      const db = openDb();
      seed(db);
      expect(db.listBranchOwners().map((r) => [r.id, r.branch, r.baseBranch]).sort()).toEqual([
        ['tree-new', 'cez/new', null], ['tree-old', 'cez/old', 'main'], ['w-1', 'cez/w-1', null],
      ]);
      expect(db.listBranchOwners().find((r) => r.id === 'tree-old')).toMatchObject({ status: 'done', archived: false, summary: JSON.stringify({ id: 'tree-old' }) });
      expect(db.findResourceHolders({ branch: 'cez/new', worktreePath: '/w/old' }).sort()).toEqual(['tree-new', 'tree-old']);
      expect(db.findResourceHolders({ branch: 'cez/none', worktreePath: '/w/none' })).toEqual([]);
    });

    it('lists every id', () => {
      const db = openDb();
      seed(db);
      expect(db.listIds().length).toBe(11);
      expect(db.has('req')).toBe(true);
      expect(db.has('missing')).toBe(false);
    });

    it('selects rows by a filter over the stored summary', () => {
      const db = openDb();
      db.transaction({
        upserts: [
          row('pinned', { summary: JSON.stringify({ id: 'pinned', pinned: true }) }),
          row('plain', { summary: JSON.stringify({ id: 'plain' }) }),
          row('archived-pinned', { archived: true, summary: JSON.stringify({ id: 'archived-pinned', pinned: true }) }),
        ],
        deletes: [],
      });
      expect(db.listWhere("archived = 0 AND json_extract(summary, '$.pinned') = 1").map((r) => r.id)).toEqual(['pinned']);
      expect(db.listWhere('status = ?', ['done']).length).toBe(3);
    });

    it('serves every named query from its index', () => {
      const db = openDb();
      seed(db);
      const raw = new DatabaseSync(path);
      try {
        const plan = (sql: string) => raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => String(r.detail)).join(' | ');
        expect(plan('SELECT id FROM runs WHERE live = 1')).toContain('USING INDEX runs_live');
        expect(plan("SELECT id FROM runs WHERE parent_run_id = 'x'")).toContain('runs_parent_run_id');
        expect(plan("SELECT id FROM runs WHERE client_request_id = 'x'")).toContain('runs_client_request_id');
        expect(plan("SELECT id FROM runs WHERE group_id = 'x'")).toContain('runs_group_id');
        expect(plan('SELECT id FROM runs WHERE worktree_path IS NOT NULL')).toContain('runs_worktree_path');
        expect(plan('SELECT id FROM runs WHERE branch IS NOT NULL')).toContain('runs_branch');
      } finally {
        raw.close();
      }
    });
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
