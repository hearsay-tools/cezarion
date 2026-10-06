import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toRunSummary } from '@open-mercato/cezar-contract';
import { readRunIndexFromDisk, searchRunIndexFromDisk } from './run-index.ts';
import { RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import { readPersistedRuns, seedRuns } from './run-store.testkit.ts';
import { RunStore, type RunRecord } from './store.ts';

const handle = { owner: 'local', name: 'repo' };
const foreignPr = 'https://github.com/foreign/repo/pull/42';
const foreignIssue = 'https://github.com/foreign/repo/issues/43';
const localPr = 'https://github.com/local/repo/pull/44';
const record = (over: Record<string, unknown> = {}) => ({
  id: 'cold', title: 'Research', workflow: 'build', task: 'research', status: 'done',
  createdAt: '2026-09-01T00:00:00Z', tokensUsed: 0, archived: false, steps: [],
  referencedPullRequestUrl: foreignPr, referencedIssueUrl: foreignIssue,
  referencedPrCandidates: [foreignPr], referencedIssueCandidates: [foreignIssue],
  issueNumber: 43, referencedIssueNumberSeeded: true,
  ...over,
});

/** A worker's delegation that validates, so the store and the reader both read it as a worker. */
const workerOf = (parentRunId: string) => {
  const id = randomUUID();
  return {
    role: 'worker', parentRunId: uuidOf(parentRunId), permissions: [],
    workspace: { ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path: `/managed/${id}`, branch: `cez/${id}`, baselineSha: '0'.repeat(40) },
  };
};
/** The schema wants a uuid parent; the role and the parent column are all these tests read. */
const uuidOf = (name: string) => `00000000-0000-4000-8000-${Buffer.from(name).toString('hex').padStart(12, '0').slice(-12)}`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-cold-refs-')); });
afterEach(() => {
  vi.restoreAllMocks();
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

// The same reference rules hold whichever file a cold project's runs live in (#779).
const sources = {
  'legacy runs.json': {
    put: (records: object[]) => writeFileSync(join(dir, 'runs.json'), JSON.stringify(records)),
    disk: () => readFileSync(join(dir, 'runs.json'), 'utf8'),
  },
  'runs.db': {
    put: (records: object[]) => seedRuns(dir, records),
    disk: () => JSON.stringify(readPersistedRuns(dir)),
  },
};

describe.each(Object.entries(sources))('repository scoping of cold disk records (%s)', (_, source) => {
  const seed = (over: Record<string, unknown> = {}) => {
    source.put([record(over)]);
    return source.disk();
  };
  const first = (identity?: typeof handle | null) => readRunIndexFromDisk(dir, { handle: identity }).runs[0];

  it('removes foreign conclusions and seeded numbers, leaving every byte on disk alone', () => {
    const bytes = seed();
    const run = first(handle);
    expect(run?.referencedPullRequestUrl).toBeUndefined();
    expect(run?.referencedIssueUrl).toBeUndefined();
    expect(run?.issueNumber).toBeUndefined();
    expect(source.disk()).toBe(bytes);
    // Scoping one read cannot mutate a subsequent unknown-identity read.
    expect(first()?.referencedPullRequestUrl).toBe(foreignPr);
  });

  it.each([undefined, null])('keeps previous behavior for unknown identity %s', (identity) => {
    seed();
    expect(first(identity)).toMatchObject({
      referencedPullRequestUrl: foreignPr, referencedIssueUrl: foreignIssue, issueNumber: 43,
    });
  });

  it.each(['port FOREIGN/Repo', `review ${foreignPr}`])('keeps prompt evidence: %s', (task) => {
    seed({ task });
    expect(first(handle)).toMatchObject({
      referencedPullRequestUrl: foreignPr, referencedIssueUrl: foreignIssue, issueNumber: 43,
    });
  });

  it('does not mistake a repository prefix in the prompt for corroboration', () => {
    seed({ task: 'port foreign/repository' });
    expect(first(handle)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('preserves declared numbers, independently owned issue numbers and created PR ownership', () => {
    seed({
      markerRefs: { pr: 42, issue: 43 }, prNumber: 42,
      issueNumber: 43, referencedIssueNumberSeeded: undefined,
      pullRequestUrl: 'https://github.com/foreign/repo/pull/99',
    });
    const run = first(handle);
    expect(run).toMatchObject({
      markerRefs: { pr: 42, issue: 43 }, prNumber: 42, issueNumber: 43,
      pullRequestUrl: 'https://github.com/foreign/repo/pull/99',
    });
    expect(run?.referencedPullRequestUrl).toBeUndefined();
    expect(run?.referencedIssueUrl).toBeUndefined();
  });

  it('keeps local references and does not promote an ambiguous candidate by removing foreign evidence', () => {
    seed({ referencedPullRequestUrl: localPr });
    expect(first(handle)?.referencedPullRequestUrl).toBe(localPr);
    seed({ referencedPullRequestUrl: undefined, referencedPrCandidates: [foreignPr, localPr] });
    expect(first(handle)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('scopes references restored by loaded-record reconciliation', () => {
    seed({
      referencedPullRequestUrl: undefined, markerRefs: { pr: 99 },
      pullRequestUrl: 'https://github.com/local/repo/pull/99',
    });
    expect(first()?.referencedPullRequestUrl).toBe(foreignPr);
    expect(first(handle)?.referencedPullRequestUrl).toBeUndefined();
  });

  it('reads a run a crashed process left live as interrupted, never as running', () => {
    seed({ status: 'running', activity: 'monitoring', steps: [{ id: 's', name: 'S', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 }] });
    expect(first()).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
    expect(first()).not.toHaveProperty('activity');
  });

  it('answers the window newest first: every unarchived run and the newest archived roots', () => {
    source.put([
      ...['a', 'bb', 'ccc', 'dddd'].map((id, i) => record({ id, createdAt: `2026-09-0${i + 1}T00:00:00Z`, archived: i > 0 })),
      record({ id: 'worker', createdAt: '2026-09-09T00:00:00Z', archived: true, delegation: workerOf('dddd') }),
    ]);
    expect(readRunIndexFromDisk(dir, { archivedWindow: 2 })).toMatchObject({
      runs: [{ id: 'dddd', archived: true }, { id: 'ccc' }, { id: 'a', archived: false }], truncated: true,
    });
    expect(readRunIndexFromDisk(dir, { archivedWindow: 3 }).truncated).toBe(false);
    expect(readRunIndexFromDisk(dir).runs.map((run) => run.id)).toEqual(['worker', 'dddd', 'ccc', 'bb', 'a']);
  });

  it('finds a root at any age by title or reference number, never a worker', () => {
    source.put([
      record({ id: 'oldest', title: 'Bound the lists', createdAt: '2026-01-01T00:00:00Z', archived: true, issueNumber: 864, referencedIssueNumberSeeded: false, referencedIssueUrl: undefined, referencedIssueCandidates: [] }),
      ...Array.from({ length: 5 }, (_, i) => record({ id: `newer-${i}`, createdAt: `2026-09-0${i + 1}T00:00:00Z`, archived: true })),
      record({ id: 'worker', title: 'Bound the lists too', createdAt: '2026-09-09T00:00:00Z', archived: true, delegation: workerOf('oldest') }),
    ]);
    expect(searchRunIndexFromDisk(dir, 'bound lists', { limit: 50 }).runs.map((run) => run.id)).toEqual(['oldest']);
    expect(searchRunIndexFromDisk(dir, '#864', { limit: 50 }).runs.map((run) => run.id)).toEqual(['oldest']);
    expect(searchRunIndexFromDisk(dir, 'research', { limit: 2 })).toMatchObject({ runs: [{ id: 'newer-4' }, { id: 'newer-3' }], truncated: true });
  });
});

describe('the cold window agrees with the store', () => {
  it('lists the same rows in the same order, with the same truncated', () => {
    const records = [
      record({ id: 'live-old', status: 'done', createdAt: '2026-01-01T00:00:00Z' }),
      ...Array.from({ length: 6 }, (_, i) => record({ id: `arch-${i}`, createdAt: `2026-09-0${i + 1}T00:00:00Z`, archived: true })),
      record({ id: 'w', createdAt: '2026-09-09T00:00:00Z', archived: true, delegation: workerOf('arch-5') }),
    ];
    seedRuns(dir, records);
    const cold = readRunIndexFromDisk(dir, { archivedWindow: 4 });
    const store = RunStore.open(dir);
    try {
      const owned = store.listRunSummaries({ archivedWindow: 4 });
      expect(cold.runs.map((run) => run.id)).toEqual(owned.runs.map((run) => run.id));
      expect(cold.truncated).toBe(owned.truncated);
    } finally {
      store.close();
    }
  });
});

describe('cold search of an unreadable project', () => {
  it('answers nothing and does not throw for a runs.db that is not a database', () => {
    writeFileSync(join(dir, RUNS_DB_FILE), 'not a database at all, just bytes');
    expect(searchRunIndexFromDisk(dir, 'anything', { limit: 50 })).toEqual({ runs: [], truncated: false });
  });
});

describe('cold reads of runs.db', () => {
  const dbPath = () => join(dir, RUNS_DB_FILE);

  it('serves the stored summary column and decodes no record it does not have to', () => {
    const run = record({ referencedPullRequestUrl: undefined, referencedIssueUrl: undefined }) as unknown as RunRecord;
    const db = RunDatabase.open(dbPath());
    // A record that would not even parse: only its summary can be what the reader returned.
    db.transaction({ upserts: [{ ...encodeRunRow(run), data: 'not a record' }], deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: '{}' } });
    db.close();
    expect(readRunIndexFromDisk(dir).runs).toEqual([JSON.parse(JSON.stringify(toRunSummary(run)))]);
  });

  it('leaves out a row it had to decode and could not, and says so once per project', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const steps = [{ id: 's', name: 's', kind: 'agent', status: 'bogus', iterations: 1, tokensUsed: 0 }];
    seedRuns(dir, [record({ id: 'ok', referencedPullRequestUrl: undefined, referencedIssueUrl: undefined }), record({ id: 'live', status: 'running', steps })]);
    expect(readRunIndexFromDisk(dir).runs.map((run) => run.id)).toEqual(['ok']);
    expect(readRunIndexFromDisk(dir).runs.map((run) => run.id)).toEqual(['ok']);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`1 run(s) in ${join(dir, RUNS_DB_FILE)} could not be read`));
  });

  it('ignores the frozen runs.json once the import is complete, and reads it until then', () => {
    writeFileSync(join(dir, 'runs.json'), JSON.stringify([record({ id: 'legacy' })]));
    expect(readRunIndexFromDisk(dir).runs.map((run) => run.id)).toEqual(['legacy']);
    // A database with no completed import is not authoritative yet.
    RunDatabase.open(dbPath()).close();
    expect(readRunIndexFromDisk(dir).runs.map((run) => run.id)).toEqual(['legacy']);
    RunStore.open(dir).close();
    writeFileSync(join(dir, 'runs.json'), JSON.stringify([record({ id: 'written-by-an-older-cezar' })]));
    expect(readRunIndexFromDisk(dir).runs.map((run) => run.id)).toEqual(['legacy']);
  });

  it('reads every record of a never-imported runs.json that parses, as its import will', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(join(dir, 'runs.json'), JSON.stringify([record({ id: 'a' }), { id: 'broken' }, record({ id: 'bb' })]));
    expect(readRunIndexFromDisk(dir).runs.map((run) => run.id).sort()).toEqual(['a', 'bb']);
    RunStore.open(dir, {}).close();
    expect(readRunIndexFromDisk(dir).runs.map((run) => run.id).sort()).toEqual(['a', 'bb']);
  });

  it('creates no database, directory or migration', () => {
    writeFileSync(join(dir, 'runs.json'), JSON.stringify([record()]));
    readRunIndexFromDisk(dir);
    expect(readdirSync(dir)).toEqual(['runs.json']);

    writeFileSync(dbPath(), '');
    readRunIndexFromDisk(dir);
    expect(readdirSync(dir).sort()).toEqual([RUNS_DB_FILE, 'runs.json']);
    expect(readFileSync(dbPath()).length).toBe(0);
  });

  it('answers nothing for a database it cannot read, never the stale runs.json, and leaves it alone', () => {
    writeFileSync(join(dir, 'runs.json'), JSON.stringify([record()]));
    writeFileSync(dbPath(), 'corrupt '.repeat(600));
    expect(readRunIndexFromDisk(dir)).toEqual({ runs: [], truncated: false });
    expect(readFileSync(dbPath(), 'utf8')).toBe('corrupt '.repeat(600));
  });

  describe.skipIf(process.getuid?.() === 0)('in a read-only directory', () => {
    it('reads through a writer\'s WAL, creating nothing', () => {
      const store = RunStore.open(dir);
      const run = store.createRun({ title: 'live writer', workflow: 'w', task: 't', steps: [] });
      store.updateRun(run.id, { status: 'done' });
      store.flush();
      const before = readdirSync(dir).sort();
      chmodSync(dir, 0o555);
      try {
        expect(readRunIndexFromDisk(dir).runs.map((saved) => saved.title)).toEqual(['live writer']);
        expect(readdirSync(dir).sort()).toEqual(before);
      } finally {
        chmodSync(dir, 0o755);
        store.close();
      }
    });

    it('answers nothing when SQLite cannot open the closed database read-only, creating nothing', () => {
      seedRuns(dir, [record()]);
      writeFileSync(join(dir, 'runs.json'), JSON.stringify([record({ id: 'stale' })]));
      const before = readdirSync(dir).sort();
      chmodSync(dir, 0o555);
      expect(readRunIndexFromDisk(dir)).toEqual({ runs: [], truncated: false });
      expect(readdirSync(dir).sort()).toEqual(before);
    });

    it('still reads a project that was never migrated', () => {
      writeFileSync(join(dir, 'runs.json'), JSON.stringify([record({ id: 'legacy' })]));
      chmodSync(dir, 0o555);
      expect(readRunIndexFromDisk(dir).runs.map((run) => run.id)).toEqual(['legacy']);
      expect(readdirSync(dir)).toEqual(['runs.json']);
    });
  });
});
