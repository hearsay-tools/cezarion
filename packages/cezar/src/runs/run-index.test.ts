import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import { findColdRunByCheckout, readRunIndexFromDisk, searchRunIndexFromDisk } from './run-index.ts';
import { RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import { setRunStatus, readPersistedRuns, seedRuns } from './run-store.testkit.ts';
import { decodeRunRecord, reconcileLoadedRun, RunStore, type RunRecord } from './store.ts';
import { rescopeRun } from './run-references.ts';

const handle = { owner: 'local', name: 'repo' };
const foreignPr = 'https://github.com/foreign/repo/pull/42';
const foreignIssue = 'https://github.com/foreign/repo/issues/43';
const localPr = 'https://github.com/local/repo/pull/44';
const record = (over: Record<string, unknown> = {}) => ({
  id: 'cold', title: 'Research', workflow: 'build', task: 'research', status: RUN_STATUS.done,
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

  // No process in this cockpit holding a live run does not make it failed: its owner, or
  // recovery once this cockpit builds the project, decides how it ends (hearsay-tools/squawk#967).
  it('reads a live run as its stored status, never as interrupted', () => {
    seed({ status: RUN_STATUS.running, steps: [{ id: 's', name: 'S', kind: STEP_KIND.agent, status: STEP_STATUS.running, iterations: 1, tokensUsed: 0 }] });
    expect(first()).toMatchObject({ status: RUN_STATUS.running });
    expect(first()).not.toHaveProperty('error');
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
    // With roots (the runs index), no worker at all, archived or not (#864).
    expect(readRunIndexFromDisk(dir, { archivedWindow: 3, roots: true }).runs.map((run) => run.id)).toEqual(['dddd', 'ccc', 'bb', 'a']);
    source.put([record({ id: 'root' }), record({ id: 'w', createdAt: '2026-09-09T00:00:00Z', delegation: workerOf('root') })]);
    expect(readRunIndexFromDisk(dir, { archivedWindow: 3, roots: true }).runs.map((run) => run.id)).toEqual(['root']);
    expect(readRunIndexFromDisk(dir, { archivedWindow: 3 }).runs.map((run) => run.id)).toEqual(['w', 'root']);
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

// The desktop version picker names each Squawk checkout by the task that owns it.
describe.each(Object.entries(sources))('the run that owns a checkout (%s)', (_, source) => {
  it('finds the run by its worktree first, else the newest owner of the branch', () => {
    source.put([
      record({ id: 'by-worktree', title: 'Worktree owner', worktreePath: '/repo/.ai/cezar/worktrees/a', branch: 'cez/a' }),
      record({ id: 'older', title: 'Older owner', createdAt: '2026-09-01T00:00:00Z', branch: 'cez/b' }),
      record({ id: 'newer', title: 'Newer owner', createdAt: '2026-09-02T00:00:00Z', branch: 'cez/b' }),
    ]);
    expect(findColdRunByCheckout(dir, { worktreePaths: ['/elsewhere', '/repo/.ai/cezar/worktrees/a'], branch: 'cez/b' })?.id).toBe('by-worktree');
    expect(findColdRunByCheckout(dir, { worktreePaths: ['/repo/.ai/cezar/worktrees/b'], branch: 'cez/b' })?.title).toBe('Newer owner');
    expect(findColdRunByCheckout(dir, { worktreePaths: ['/repo'], branch: 'main' })).toBeUndefined();
    expect(findColdRunByCheckout(dir, { worktreePaths: ['/repo'], branch: null })).toBeUndefined();
  });
});

describe('the cold window agrees with the store', () => {
  it('lists the same rows in the same order, with the same truncated', () => {
    const records = [
      record({ id: 'live-old', status: RUN_STATUS.done, createdAt: '2026-01-01T00:00:00Z' }),
      ...Array.from({ length: 6 }, (_, i) => record({ id: `arch-${i}`, createdAt: `2026-09-0${i + 1}T00:00:00Z`, archived: true })),
      record({ id: 'w', createdAt: '2026-09-09T00:00:00Z', archived: true, delegation: workerOf('arch-5') }),
      record({ id: 'w-live', createdAt: '2026-09-10T00:00:00Z', delegation: workerOf('live-old') }),
    ];
    seedRuns(dir, records);
    const cold = readRunIndexFromDisk(dir, { archivedWindow: 4 });
    const coldRoots = readRunIndexFromDisk(dir, { archivedWindow: 4, roots: true });
    const store = RunStore.open(dir);
    try {
      const owned = store.listRunSummaries({ archivedWindow: 4 });
      expect(cold.runs.map((run) => run.id)).toEqual(owned.runs.map((run) => run.id));
      expect(cold.truncated).toBe(owned.truncated);
      const ownedRoots = store.listRunSummaries({ archivedWindow: 4, roots: true });
      expect(coldRoots.runs.map((run) => run.id)).toEqual(ownedRoots.runs.map((run) => run.id));
      expect(coldRoots.runs.map((run) => run.id)).not.toContain('w-live');
      expect(cold.runs.map((run) => run.id)).toContain('w-live');
    } finally {
      store.close();
    }
  });
});

/**
 * One raw row per read-time rule, in the shape an older build wrote it: the stored summary and
 * `live` column are that build's. The cold reader, a store opened as `serve` opens a project
 * (`keepLive`), and `toRunSummary` of the normalized record must agree on each row, field for
 * field (hearsay-tools/squawk#1502). A rule whose rows only one read path selects fails here.
 */
describe('the cold reader and the store read every repaired row alike', () => {
  const steps = [{ id: 's', name: 'S', kind: STEP_KIND.agent, status: STEP_STATUS.running, iterations: 1, tokensUsed: 0 }];
  const base = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: id, workflow: 'build', task: 'research', status: RUN_STATUS.done,
    createdAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T01:00:00Z', tokensUsed: 0, archived: false, steps: [], ...over,
  });
  const corpus = [
    // Rule 1: an accepted Stop reads cancelled, even on a row that settled before it did.
    base('stop', { stopping: true }),
    // Rule 2 (hearsay-tools/squawk#967): a live run keeps its status; no holder here is no failure.
    base('live', { status: RUN_STATUS.running, finishedAt: undefined, steps }),
    // Rule 3: a failed usage-limit row reads waiting; a stale resume time on a finished run goes.
    base('limit', { status: RUN_STATUS.failed, error: 'usage limit', autoResumeAt: '2026-10-06T00:00:00.000Z' }),
    base('stale-resume', { autoResumeAt: '2026-10-06T00:00:00.000Z' }),
    // Rule 4: a referenced PR an older created-PR declaration erased is restored.
    base('pr-heal', { markerRefs: { pr: 9 }, pullRequestUrl: 'https://github.com/local/repo/pull/9', referencedPrCandidates: ['https://github.com/local/repo/pull/4'] }),
    // Rule 5 (hearsay-tools/cezarion#1221): a follow-up issue declaration displaced the originating issue.
    base('issue-heal', { task: 'Fix issue #1200', issueNumber: 1216, markerRefs: { issue: 1216 },
      referencedIssueUrl: 'https://github.com/local/repo/issues/1216',
      referencedIssueCandidates: ['https://github.com/local/repo/issues/1200', 'https://github.com/local/repo/issues/1216'] }),
    // Rule 6: a foreign reference the prompt does not corroborate is dropped once the handle is known.
    base('foreign', { referencedPullRequestUrl: foreignPr, referencedPrCandidates: [foreignPr], referencedIssueUrl: localPr.replace('pull/44', 'issues/45') }),
    // Rule 7: schema-3 wait fields are read into the wait list, finished or parked.
    base('monitoring', { activity: 'monitoring', monitoringWakeAt: '2026-10-06T00:00:00.000Z' }),
    base('ci-park', { status: RUN_STATUS.running, finishedAt: undefined, activity: 'monitoring', steps, ciWait: {
      id: '55555555-5555-4555-8555-555555555555', generation: 'g', turnId: 't', prUrl: 'https://github.com/local/repo/pull/9', repository: 'local/repo', prNumber: 9,
      headSha: 'a'.repeat(40), timeoutSeconds: 1800, registeredAt: '2026-10-05T00:00:00.000Z', deadline: '2026-10-05T00:30:00.000Z', phase: 'parked',
    } }),
    base('control'),
  ];
  // Rule 8: a summary stored before it carried `automationId` (hearsay-tools/cezarion#1335).
  const automation = base('automation', { automationTrigger: { automationId: 'auto-s', automationRevision: 1, receiptId: 'r', trigger: 'manual', occurrenceAt: '2026-10-05T00:00:00.000Z' } });
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const byId = (runs: readonly { id: string }[]) => new Map(runs.map((run) => [run.id, plain(run)]));

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T00:00:00Z') }); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([[undefined], [handle]])('agree row by row (handle: %o)', (identity) => {
    seedRuns(dir, [...corpus, automation]);
    const db = RunDatabase.open(join(dir, RUNS_DB_FILE));
    const { automationId: _, ...stale } = toRunSummary(automation as unknown as RunRecord);
    db.transaction({ upserts: [{ ...encodeRunRow(automation as unknown as RunRecord), summary: JSON.stringify(stale) }], deletes: [] });
    db.close();
    // Cold first: the store writes back what it repairs, which the cold reader would then serve.
    const cold = byId(readRunIndexFromDisk(dir, { handle: identity }).runs);
    const store = RunStore.open(dir, { keepLive: true });
    try {
      if (identity) store.setRepoHandle(identity);
      const owned = byId(store.listRunSummaries().runs);
      for (const raw of corpus) {
        const run = decodeRunRecord(JSON.stringify(raw))!;
        reconcileLoadedRun(run, { keepLive: true });
        rescopeRun(run, identity);
        const expected = plain(toRunSummary(run));
        expect({ id: raw.id, cold: cold.get(raw.id) }).toEqual({ id: raw.id, cold: expected });
        expect({ id: raw.id, store: owned.get(raw.id) }).toEqual({ id: raw.id, store: expected });
      }
      // The named exemption: the cold selection leaves the automation-origin heal out, because no
      // cross-project view reads `automationId` and selecting it scans every row's `data`.
      expect(owned.get('automation')).toMatchObject({ automationId: 'auto-s' });
      const { automationId: __, ...ownedRest } = owned.get('automation');
      expect(cold.get('automation')).toEqual(ownedRest);
    } finally {
      store.close();
    }
  });

  it('reads a live run another cockpit holds as that cockpit lists it (hearsay-tools/squawk#967)', () => {
    seedRuns(dir, [base('held', { status: RUN_STATUS.running, finishedAt: undefined, steps })]);
    const owner = RunStore.open(dir, { keepLive: true });
    const other = RunStore.open(dir, { keepLive: true });
    try {
      expect(other.runOwnership('held')).toBe('foreign');
      const cold = readRunIndexFromDisk(dir).runs;
      expect(cold).toEqual(other.listRunSummaries().runs);
      expect(cold).toEqual(owner.listRunSummaries().runs);
      expect(cold).toMatchObject([{ id: 'held', status: RUN_STATUS.running }]);
    } finally {
      other.close();
      owner.close();
    }
  });
});

describe('cold issue attribution repair in search', () => {
  it('recovers a malformed summary during an issue-reference search', () => {
    const run = record({ task: 'Fix issue #1200', issueNumber: 1200,
      markerRefs: { issue: 1200 }, referencedIssueUrl: undefined,
      referencedIssueCandidates: [] }) as unknown as RunRecord;
    const db = RunDatabase.open(join(dir, RUNS_DB_FILE));
    db.transaction({ upserts: [{ ...encodeRunRow(run), summary: 'malformed JSON' }],
      deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: '{}' } });
    db.close();
    expect(searchRunIndexFromDisk(dir, '#1200', { limit: 1 }).runs.map(run => run.id)).toEqual(['cold']);
  });

  it('does not decode issue-marked records for an unrelated word search', () => {
    seedRuns(dir, [record({ task: 'Fix issue #1200', title: 'Investigating attribution',
      issueNumber: 1216, markerRefs: { issue: 1216 } })]);
    const fetched = vi.spyOn(RunDatabase.prototype, 'getMany');
    expect(searchRunIndexFromDisk(dir, 'unrelatedword', { limit: 1 }).runs).toEqual([]);
    expect(fetched.mock.calls.flatMap(([ids]) => ids)).toEqual([]);
  });

  it('finds an originating issue absent from the stored summary', () => {
    seedRuns(dir, [record({ task: 'Fix issue #1200', title: 'Investigating attribution',
      issueNumber: 1216, markerRefs: { issue: 1216 },
      referencedIssueUrl: 'https://github.com/local/repo/issues/1216',
      referencedIssueCandidates: ['https://github.com/local/repo/issues/1200',
        'https://github.com/local/repo/issues/1216'],
      referencedPullRequestUrl: undefined, referencedPrCandidates: [] })]);
    for (const query of ['#1200', 'issues/1200', 'https://github.com/local/repo/issues/1200']) {
      expect(searchRunIndexFromDisk(dir, query, { limit: 1 }).runs.map(run => run.id)).toEqual(['cold']);
    }
  });
});

describe('cold search counts matches after projection', () => {
  it('keeps scanning past candidates that scoping the repository drops', () => {
    // Three newer runs match `43` only through a foreign issue the handle scopes away; the
    // oldest matches through its own title. A cap counted before projection returns nothing.
    seedRuns(dir, [
      record({ id: 'own', title: 'Fix 43 flaky tests', createdAt: '2026-01-01T00:00:00Z', referencedIssueUrl: undefined, referencedIssueCandidates: [], issueNumber: undefined, referencedIssueNumberSeeded: false, referencedPullRequestUrl: undefined, referencedPrCandidates: [] }),
      ...['f1', 'f2', 'f3'].map((id, i) => record({ id, createdAt: `2026-09-0${i + 1}T00:00:00Z` })),
    ]);
    expect(searchRunIndexFromDisk(dir, '43', { limit: 1 }).runs.map((run) => run.id)).toEqual(['f3']);
    expect(searchRunIndexFromDisk(dir, '43', { handle, limit: 1 })).toEqual({ runs: [expect.objectContaining({ id: 'own' })], truncated: false });
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
    const steps = [{ id: 's', name: 's', kind: STEP_KIND.agent, status: 'bogus', iterations: 1, tokensUsed: 0 }];
    seedRuns(dir, [record({ id: 'ok', referencedPullRequestUrl: undefined, referencedIssueUrl: undefined }), record({ id: 'live', status: RUN_STATUS.running, steps })]);
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
      setRunStatus(store, run.id, RUN_STATUS.done);
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

 it('finds every collection-only PR in a cold archived database without writing files', () => {
  const pullRequests = [812, 813, 814, 815, 816].map(number => ({ number, source: 'declared' as const }));
  seedRuns(dir, [record({ id: 'split', archived: true, pullRequests })]);
  const store = RunStore.open(dir); store.flush();
  const before = readdirSync(dir).sort();
  const bytes = readFileSync(join(dir, RUNS_DB_FILE));
  for (const number of [812, 813, 814, 815, 816]) {
    const found = searchRunIndexFromDisk(dir, `#${number}`, { limit: 50 });
    expect(found.runs.map(run => run.id)).toEqual(['split']);
    expect(found.runs[0]?.pullRequests).toEqual(pullRequests);
  }
  expect(readdirSync(dir).sort()).toEqual(before);
  expect(readFileSync(join(dir, RUNS_DB_FILE))).toEqual(bytes);
  store.close();
 });
