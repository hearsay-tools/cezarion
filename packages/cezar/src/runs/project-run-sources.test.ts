import { reportsIndex } from '../artifacts/reports-index.ts';
import { DatabaseSync } from 'node:sqlite';
import { artifactDirectory, publishArtifact, readArtifact } from '../artifacts/store.ts';
import { reclaimWorktrees } from './retention.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { readHandoff } from '../handoff.ts';
import { projectPaths } from '../project-paths.ts';
import { closeClaimSession, openClaimSession } from './run-claims.ts';
import { RUNS_IMPORT_COMPLETE_KEY, RunDatabase } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import { findColdRunByCheckout, readRunIndexFromDisk, searchRunIndexFromDisk } from './run-index.ts';
import { RunStore, runRecordSchema, type RunRecord } from './store.ts';

describe('project run sources', () => {
  let repo: string;
  const stores: RunStore[] = [];
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'project-runs-')); });
  afterEach(() => {
    stores.splice(0).forEach(store => store.close());
    vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
  });
  const root = (name: string) => join(repo, '.ai', name);
  const record = (title: string, extra: Partial<RunRecord> = {}) => runRecordSchema.parse({
    id: randomUUID(), title, task: title, workflow: 'quick-task', status: RUN_STATUS.done,
    createdAt: '2026-11-01T00:00:00Z', tokensUsed: 0, archived: false, steps: [], ...extra,
  });
  function seed(name: string, runs: RunRecord[], json = false) {
    // These fixtures exercise Squawk as fallback, including when the release switch is on.
    if (name === 'squawk') mkdirSync(root('cezar'), { recursive: true });
    const directory = root(name);
    mkdirSync(join(directory, 'runs'), { recursive: true });
    if (json) writeFileSync(join(directory, 'runs.json'), JSON.stringify(runs));
    else {
      const db = RunDatabase.open(join(directory, 'runs.db'));
      db.transaction({ upserts: runs.map(run => encodeRunRow(run)), deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: 'fixture' } });
      db.close();
    }
    return directory;
  }
  function open() {
    const store = RunStore.open(projectPaths(repo).write, { keepLive: true });
    stores.push(store);
    return store;
  }

  it.each([false, true])('reads fallback-only history and evidence without creating legacy state (JSON=%s)', async json => {
    const run = record('fallback');
    const source = seed('squawk', [run], json);
    writeFileSync(join(source, 'runs', `${run.id}.ndjson`), '{"seq":1,"ts":"2026-11-01T00:00:00Z","type":"text","text":"source history"}\n');
    writeFileSync(join(source, 'runs', `${run.id}.handoff.md`), '# fallback handoff');
    const before = readdirSync(source).sort();
    const databaseBytes = json ? undefined : readFileSync(join(source, 'runs.db'));
    const store = open();
    expect(store.getRun(run.id)?.title).toBe('fallback');
    expect(store.listRunSummaries().runs.map(item => item.id)).toEqual([run.id]);
    expect(store.listRunIds()).toEqual([run.id]);
    expect(store.readEvents(run.id)[0]?.text).toBe('source history');
    expect((await store.readEventsAsync(run.id))[0]?.text).toBe('source history');
    expect(readHandoff(store.sourceDataDir(run.id), run.id)).toBe('# fallback handoff');
    expect(store.readWorkerExecution(run.id)).toBeUndefined();
    expect(store.readWorkerProcesses(run.id, randomUUID())).toBe('absent');
    expect(readRunIndexFromDisk(root('cezar')).runs.map(item => item.id)).toEqual([run.id]);
    expect(searchRunIndexFromDisk(root('cezar'), 'fallback', { limit: 10 }).runs.map(item => item.id)).toEqual([run.id]);
    expect(readdirSync(root('cezar'))).toEqual([]);
    expect(readdirSync(source).filter(name => !['runs.db-wal', 'runs.db-shm'].includes(name)).sort()).toEqual(before);
    if (databaseBytes) expect(readFileSync(join(source, 'runs.db'))).toEqual(databaseBytes);
  });

  it('unions disjoint IDs and keeps duplicate records and all their sidecars together', () => {
    const duplicate = record('legacy duplicate');
    const old = record('legacy only');
    const fallback = record('fallback only', { branch: 'cez/fallback', worktreePath: '/fallback/worktree' });
    seed('cezar', [duplicate, old]);
    const source = seed('squawk', [{ ...duplicate, title: 'wrong fallback duplicate' }, fallback]);
    for (const run of [duplicate, fallback]) writeFileSync(join(source, 'runs', `${run.id}.ndjson`), '{"seq":1,"type":"text","text":"fallback"}\n');
    const store = open();
    expect(new Set(store.listRunSummaries().runs.map(item => item.id))).toEqual(new Set([duplicate.id, old.id, fallback.id]));
    expect(store.getRun(duplicate.id)?.title).toBe('legacy duplicate');
    expect(store.readEvents(duplicate.id)).toEqual([]);
    expect(store.readEvents(fallback.id)[0]?.text).toBe('fallback');
    expect(store.sourceDataDir(duplicate.id)).toBe(root('cezar'));
    expect(findColdRunByCheckout(root('cezar'), { worktreePaths: ['/fallback/worktree'], branch: null })?.id).toBe(fallback.id);
    expect(searchRunIndexFromDisk(root('cezar'), 'wrong fallback', { limit: 10 }).runs).toEqual([]);
  });

  it('keeps fallback runs in every cold read while the legacy runs.db has not imported runs.json yet', () => {
    const legacy = record('legacy json');
    const fallback = record('fallback only', { branch: 'cez/fallback', worktreePath: '/fallback/worktree' });
    seed('cezar', [legacy], true);
    RunDatabase.open(join(root('cezar'), 'runs.db')).close();
    seed('squawk', [fallback]);
    expect(new Set(readRunIndexFromDisk(root('cezar')).runs.map(item => item.id))).toEqual(new Set([legacy.id, fallback.id]));
    expect(searchRunIndexFromDisk(root('cezar'), 'fallback', { limit: 10 }).runs.map(item => item.id)).toEqual([fallback.id]);
    expect(findColdRunByCheckout(root('cezar'), { worktreePaths: ['/fallback/worktree'], branch: null })?.id).toBe(fallback.id);
  });

  it('refuses automatic writes to a fallback family, then copies it on explicit adoption and appends under legacy', () => {
    const run = record('fallback');
    const source = seed('squawk', [run]);
    const history = join(source, 'runs', `${run.id}.ndjson`);
    const bytes = '{"seq":1,"type":"text","text":"original"}\n';
    writeFileSync(history, bytes);
    writeFileSync(join(source, 'runs', `${run.id}.handoff.md`), '# preserved');
    const store = open();
    expect(readdirSync(root('cezar'))).toEqual([]);
    expect(() => store.appendEvent(run.id, { type: 'text', text: 'automatic' })).toThrow(/\.ai\/squawk.*binary that migrated/);
    expect(store.updateRun(run.id, { title: 'automatic' })).toBeUndefined();
    expect(store.writeRefusal(run.id)).toMatch(/\.ai\/squawk/);
    expect(readdirSync(root('cezar'))).toEqual([]);
    expect(store.adoptFallbackFamily(run.id)).toBe(true);
    store.appendEvent(run.id, { type: 'text', text: 'new' });
    store.updateRun(run.id, { title: 'changed' });
    store.flush();
    expect(store.sourceDataDir(run.id)).toBe(root('cezar'));
    expect(store.readEvents(run.id).map(event => event.text)).toEqual(['original', 'new']);
    expect(readFileSync(history, 'utf8')).toBe(bytes);
    expect(readHandoff(root('cezar'), run.id)).toBe('# preserved');
    expect(open().getRun(run.id)?.title).toBe('changed');
  });

  it('refuses explicit fallback deletion without a tombstone or any source write', () => {
    const run = record('fallback');
    seed('squawk', [run]);
    const store = open();
    expect(store.canDeleteRun(run.id)).toBe(false);
    expect(() => store.deleteRun(run.id)).toThrow(/\.ai\/squawk.*binary that migrated/);
    expect(readdirSync(root('cezar'))).toEqual([]);
    expect(store.getRun(run.id)?.title).toBe('fallback');
  });

  it('does not replace a damaged legacy database with fallback data or rewrite either file', () => {
    seed('squawk', [record('fallback')]);
    mkdirSync(root('cezar'), { recursive: true });
    const path = join(root('cezar'), 'runs.db');
    writeFileSync(path, 'damaged legacy database');
    expect(() => open()).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('damaged legacy database');
  });
  it('refuses duplicate deletion too, while legacy-only deletion remains unchanged', () => {
    const duplicate = record('duplicate');
    const old = record('legacy only');
    seed('cezar', [duplicate, old]);
    seed('squawk', [{ ...duplicate, title: 'fallback copy' }]);
    const store = open();
    expect(store.isFallbackRun(duplicate.id)).toBe(false);
    expect(store.canDeleteRun(duplicate.id, 'worktree')).toBe(true);
    expect(store.canDeleteRun(duplicate.id)).toBe(false);
    expect(() => store.deleteRun(duplicate.id)).toThrow(/\.ai\/squawk.*binary that migrated/);
    expect(store.deleteRun(old.id)).toBe(true);
    store.flush();
    expect(store.getRun(old.id)).toBeUndefined();
    expect(store.getRun(duplicate.id)?.title).toBe('duplicate');
  });

  it('keeps fallback live rows readable without recovering or claiming them at boot', () => {
    const run = record('waiting fallback', { status: RUN_STATUS.waiting });
    seed('squawk', [run]);
    const store = open();
    expect(store.getRun(run.id)?.status).toBe('waiting');
    expect(store.listRuns()).toEqual([]);
    expect(store.runOwnership(run.id)).toBe('fallback');
    expect(readdirSync(root('cezar'))).toEqual([]);
  });

  it.each([0, 999])('degrades unsupported fallback schema %s to one warning without creating a legacy database', version => {
    const source = seed('squawk', [record('future')]);
    const path = join(source, 'runs.db');
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${version}`);
    db.close();
    const bytes = readFileSync(path);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(open().listRunIds()).toEqual([]);
    expect(open().listRunIds()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(path);
    expect(readdirSync(root('cezar'))).toEqual([]);
    expect(readFileSync(path)).toEqual(bytes);
  });

  it.each(['locked', 'unreadable'])('degrades a %s fallback database to one warning and leaves both stores untouched', reason => {
    const source = seed('squawk', [record('fallback')]);
    const path = join(source, 'runs.db');
    const before = readFileSync(path);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(RunDatabase, 'openReadOnly').mockImplementation(() => { throw new Error(reason); });
    expect(open().listRunIds()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(reason);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(root('cezar'))).toEqual([]);
  });

  it('keeps live foreign fallback families readable but refuses an explicit write before creating legacy state', () => {
    const run = record('foreign', { status: RUN_STATUS.waiting });
    const source = seed('squawk', [run]);
    const owner = openClaimSession();
    const db = RunDatabase.open(join(source, 'runs.db'));
    try {
      db.takeClaims(owner, [{ family: run.id, expect: null }]);
      const store = open();
      expect(store.getRun(run.id)?.title).toBe('foreign');
      expect(store.runOwnership(run.id)).toBe('fallback');
      expect(store.updateRun(run.id, { title: 'unsafe' })).toBeUndefined();
      expect(() => store.adoptFallbackFamily(run.id)).toThrow('in use by another process');
      expect(store.getRun(run.id)?.title).toBe('foreign');
      expect(readdirSync(root('cezar'))).toEqual([]);
      expect(db.get(run.id)?.data).toContain('foreign');
    } finally { db.close(); closeClaimSession(owner.session); }
  });

  it('reads fallback artifacts and reports even when the legacy report backfill was complete', async () => {
    const old = record('old');
    seed('cezar', [old]);
    await reportsIndex(open()).list({});
    const run = record('fallback report');
    const source = seed('squawk', [run]);
    const document = join(repo, 'report.html');
    writeFileSync(document, '<title>Fallback report</title>');
    const artifact = await publishArtifact(artifactDirectory(source, run.id), run.id, document);
    const store = open();
    expect((await readArtifact(artifactDirectory(store.sourceDataDir(run.id), run.id), run.id, artifact.id))?.bytes.toString()).toContain('Fallback report');
    expect((await reportsIndex(store).list({}))).toMatchObject({ reports: [{ id: artifact.id, runId: run.id }] });
  });

  it('writes the report retry marker for a fallback-only run, so the watcher retries its scan', () => {
    const run = record('fallback report');
    seed('squawk', [run]);
    const store = open();
    const db = (store as unknown as { db: RunDatabase }).db;
    db.reports.retry(run.id, 1);
    expect(db.reports.dirty()).toContain(run.id);
    expect(existsSync(join(root('cezar'), 'runs.db'))).toBe(false);
  });

  it('reports fallback cleanup skips once per sweep and still reclaims legacy byte-only resources', async () => {
    const newest = record('new', { worktreePath: join(root('cezar'), 'worktrees', 'new'), finishedAt: '2026-11-08T00:00:00Z' });
    const old = record('legacy', { worktreePath: join(root('cezar'), 'worktrees', 'old') });
    const fallback = record('fallback', { worktreePath: join(root('squawk'), 'worktrees', 'fallback') });
    for (const run of [newest, old, fallback]) mkdirSync(run.worktreePath!, { recursive: true });
    seed('cezar', [newest, old]);
    seed('squawk', [{ ...old }, fallback]);
    const store = open();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const remove = vi.fn(async (_repo: string, path: string) => { rmSync(path, { recursive: true }); });
    expect(await reclaimWorktrees(repo, store, 1, { remove })).toEqual([old.id]);
    expect(existsSync(fallback.worktreePath!)).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/skipped 1.*\.ai\/squawk/);
  });

  it('does not archive fallback or duplicate records during count retention', () => {
    const protectedRun = record('fallback oldest');
    seed('squawk', [protectedRun]);
    seed('cezar', [{ ...protectedRun, title: 'duplicate oldest' }, ...Array.from({ length: 300 }, (_, i) => record(`recent ${i}`, { createdAt: '2026-11-08T00:00:00Z' }))]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const store = open();
    store.createRun({ title: 'new', task: 'new', workflow: 'quick-task', steps: [] });
    store.flush();
    expect(store.getRun(protectedRun.id)?.archived).toBe(false);
    expect(info.mock.calls.filter(([line]) => String(line).includes('read-only fallback run'))).toHaveLength(1);
  });

  it('keeps copied worker result snapshots readable and source bytes unchanged after a family write', () => {
    const workerId = randomUUID(), parentId = randomUUID(), snapshotId = randomUUID();
    const observedAt = '2026-11-01T00:00:00Z';
    const workspace = { ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated' as const,
      path: join(root('squawk'), 'worktrees', workerId), branch: 'cez/worker', baselineSha: 'a'.repeat(40) };
    const parent = record('parent', { id: parentId, delegation: { role: 'root', permissions: [],
      receipts: [{ workerId, requestId: randomUUID(), requestHash: 'b'.repeat(64) }],
      results: [{ workerId, revision: 0, observedAt, snapshotId, lastExecutionOutcome: 'completed' }] } });
    const worker = record('worker', { id: workerId, delegation: { role: 'worker', parentRunId: parentId, permissions: [], workspace } });
    const source = seed('squawk', [parent, worker]);
    const directory = join(source, 'runs', `${parentId}-worker-results`);
    mkdirSync(directory);
    const path = join(directory, `${workerId}.${snapshotId}.json`);
    const bytes = JSON.stringify({ result: { workerId, parentRunId: parentId, revision: 0, observedAt,
      status: RUN_STATUS.done, outcome: 'completed', lastExecutionOutcome: 'completed', partial: false, settled: true,
      baselineSha: workspace.baselineSha, workspace, cleanup: 'retained',
      summary: { state: 'unavailable', reason: 'missing' }, head: { state: 'available', sha: workspace.baselineSha },
      diff: { state: 'available', snapshotId, path, truncated: false }, artifacts: { state: 'available', items: [], truncated: false } }, diffSnapshot: 'retained patch' });
    writeFileSync(path, bytes);
    const store = open();
    expect(store.readWorkerResultDiff(parentId, workerId)).toBe('retained patch');
    expect(store.adoptFallbackFamily(workerId)).toBe(true);
    store.updateRun(workerId, { title: 'explicit write' });
    store.flush();
    expect(store.sourceDataDir(parentId)).toBe(root('cezar'));
    expect(store.readWorkerResultDiff(parentId, workerId)).toBe('retained patch');
    expect(store.readWorkerResult(parentId, workerId)?.diff).toMatchObject({ path: join(root('cezar'), 'runs', `${parentId}-worker-results`, `${workerId}.${snapshotId}.json`) });
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it.each([false, true])('recovers crash-left sidecars only when their bytes match (different=%s)', different => {
    const run = record('fallback');
    const source = seed('squawk', [run]);
    const name = `${run.id}-worker-results`;
    mkdirSync(join(source, 'runs', name));
    writeFileSync(join(source, 'runs', name, 'result.json'), 'source evidence');
    mkdirSync(join(root('cezar'), 'runs', name), { recursive: true });
    writeFileSync(join(root('cezar'), 'runs', name, 'result.json'), different ? 'other evidence' : 'source evidence');
    const store = open();
    if (different) {
      expect(() => store.adoptFallbackFamily(run.id)).toThrow('sidecar already exists');
      expect(store.isFallbackRun(run.id)).toBe(true);
      expect(readFileSync(join(root('cezar'), 'runs', name, 'result.json'), 'utf8')).toBe('other evidence');
    } else {
      store.adoptFallbackFamily(run.id);
      store.updateRun(run.id, { title: 'changed' });
      store.flush();
      expect(store.isFallbackRun(run.id)).toBe(false);
      expect(store.getRun(run.id)?.title).toBe('changed');
      expect(readFileSync(join(root('cezar'), 'runs', name, 'result.json'), 'utf8')).toBe('source evidence');
    }
    expect(readFileSync(join(source, 'runs', name, 'result.json'), 'utf8')).toBe('source evidence');
  });

  it('does not load or normalize fallback members of an anchored legacy family at boot', () => {
    const parent = record('legacy', { status: RUN_STATUS.waiting });
    const workerId = randomUUID();
    const worker = record('fallback worker', { id: workerId, status: RUN_STATUS.running, delegation: { role: 'worker', parentRunId: parent.id, permissions: [], workspace: { ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated', path: '/checkout', branch: 'shared', baselineSha: 'a'.repeat(40) } } });
    seed('cezar', [parent]);
    seed('squawk', [worker]);
    const store = open();
    expect(store.getRun(worker.id)?.title).toBe('fallback worker');
    expect(store.listWorkersOf(parent.id).map(run => run.id)).toContain(worker.id);
    expect(store.listRuns().map(run => run.id)).not.toContain(worker.id);
    expect(store.getRun(worker.id)?.status).toBe(RUN_STATUS.running);
    store.flush();
    const db = RunDatabase.open(join(root('cezar'), 'runs.db'));
    try { expect(db.has(worker.id)).toBe(false); } finally { db.close(); }
  });

  it('preserves a fallback family before an explicit adoption makes its records mutable', () => {
    const parent = record('orphan', { status: RUN_STATUS.running });
    seed('squawk', [parent]);
    const store = open();
    expect(store.listRuns()).toEqual([]);
    expect(store.adoptFamily(parent.id, { stop: true })).toBeUndefined();
    expect(store.adoptFallbackFamily(parent.id)).toBe(true);
    expect(store.adoptFamily(parent.id, { stop: true })).toBe(parent.id);
    store.flush();
    expect(store.isFallbackRun(parent.id)).toBe(false);
    expect(store.getRun(parent.id)?.status).toBe(RUN_STATUS.cancelled);
    const source = RunDatabase.openReadOnly(join(root('squawk'), 'runs.db'))!;
    try { expect(JSON.parse(source.get(parent.id)!.data).status).toBe(RUN_STATUS.running); }
    finally { source.close(); }
  });

  it('creates new state only under the selected root when neither directory exists', () => {
    const paths = projectPaths(repo);
    const store = open();
    expect(store.listRunIds()).toEqual([]);
    store.createRun({ title: 'new', task: 'new', workflow: 'quick-task', steps: [] });
    store.flush();
    expect(existsSync(join(paths.write, 'runs.db'))).toBe(true);
    expect(existsSync(paths.reads[1]!)).toBe(false);
  });

  it('rolls back preserved sidecars and records when a family write fails', () => {
    const run = record('fallback');
    const source = seed('squawk', [run]);
    const history = join(source, 'runs', `${run.id}.ndjson`);
    writeFileSync(history, '{"seq":1,"type":"text","text":"original"}\n');
    const store = open();
    const transaction = RunDatabase.prototype.transaction;
    vi.spyOn(RunDatabase.prototype, 'transaction').mockImplementation(function (this: RunDatabase, changes) {
      return transaction.call(this, changes.adoptFallback?.length ? { ...changes, beforeCommit: () => { throw new Error('injected failure'); } } : changes);
    });
    expect(() => store.adoptFallbackFamily(run.id)).toThrow('injected failure');
    expect(store.isFallbackRun(run.id)).toBe(true);
    expect(existsSync(join(root('cezar'), 'runs', `${run.id}.ndjson`))).toBe(false);
    expect(readFileSync(history, 'utf8')).toContain('original');
    vi.restoreAllMocks();
    store.adoptFallbackFamily(run.id);
    store.updateRun(run.id, { title: 'retry' });
    store.flush();
    expect(store.getRun(run.id)?.title).toBe('retry');
    expect(store.readEvents(run.id)[0]?.text).toBe('original');
  });

});
