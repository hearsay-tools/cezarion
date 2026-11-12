import { logPrefix } from '../home/display.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, cpSync, realpathSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportsResponseSchema, reportsStateSchema, REPORTS_QUERY_MAX } from '@open-mercato/cezar-contract/reports';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { artifactDirectory, publishArtifact, readArtifact } from '../artifacts/store.ts';
import { reportsIndex, REPORTS_BACKFILL_KEY } from '../artifacts/reports-index.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('project reports', () => {
  let root: string, dataDir: string, store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-reports-'));
    dataDir = join(root, '.ai/cezar');
    store = RunStore.open(dataDir);
  });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const task = (title = 'Source task') => store.createRun({ title, workflow: 'quick-task', task: 'Searchable source prompt', steps: [] });
  const publish = async (id: string, name = 'analysis.html', title = 'Quarterly results') => {
    const source = join(root, name); writeFileSync(source, `<title>${title}</title><p>report</p>`);
    return publishArtifact(artifactDirectory(dataDir, id), id, source);
  };
  const get = (query = '', project = 'default') => apiRequest(createApp({ home: testHome(), repoRoot: root, store, manager: {} as RunManager, version: 'test' }), `/api/v1/p/${project}/reports${query}`);
  const page = async (query = '') => reportsResponseSchema.parse(await (await get(query)).json());

  it('serves the project state twin and marks finite watch demand', async () => {
    const index = reportsIndex(store);
    const mark = vi.spyOn(index, 'markRead');
    const response = await get('/state');
    expect(response.status).toBe(200);
    expect(reportsStateSchema.parse(await response.json())).toEqual(index.state());
    expect(mark).toHaveBeenCalledOnce();
  });

  it('backfills HTML from archived and terminal tasks, records completion, and preserves files after worktree removal', async () => {
    const run = task();
    const artifact = await publish(run.id);
    await publish(run.id, 'notes.txt');
    setRunStatus(store, run.id, RUN_STATUS.done, { archived: true, worktreeReclaimedAt: new Date().toISOString() });
    expect((await page()).reports).toEqual([expect.objectContaining({ id: artifact.id, title: 'Quarterly results', taskTitle: 'Source task', taskStatus: 'done' })]);
    const db = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try { expect(db.prepare('SELECT value FROM meta WHERE key = ?').get(REPORTS_BACKFILL_KEY)).toBeTruthy(); }
    finally { db.close(); }
  });

  it('rebuilds cache rows after removing the backfill marker, without losing snapshots or task history', async () => {
    const run = task(); const artifact = await publish(run.id); await page();
    store.close();
    const raw = new DatabaseSync(join(dataDir, 'runs.db'));
    raw.prepare('DELETE FROM meta WHERE key = ?').run(REPORTS_BACKFILL_KEY);
    raw.exec('DELETE FROM artifacts'); raw.close();
    store = RunStore.open(dataDir);
    expect((await page()).reports.map(a => a.id)).toEqual([artifact.id]);
  });

  it('reconciles publications made by live tasks after backfill and on committed settlement without a query', async () => {
    const run = task();
    reportsIndex(store).start();
    await page();
    const first = await publish(run.id);
    expect((await page()).reports.map(a => a.id)).toContain(first.id);
    const second = await publish(run.id, 'second.htm');
    setRunStatus(store, run.id, RUN_STATUS.done);
    store.flush();
    // Wait for the settlement listener's serialized work, without invoking list/reconcile.
    await vi.waitFor(() => {
      const db = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
      try { expect(db.prepare('SELECT id FROM artifacts WHERE id = ?').get(second.id)).toBeTruthy(); }
      finally { db.close(); }
    }, { timeout: 10_000 });
  });

  it('reconciles a run that was live in another process and settled between shelf queries', async () => {
    await page();
    const writer = RunStore.open(dataDir, { keepLive: true });
    let artifactId: string;
    try {
      const run = writer.createRun({ title: 'Between queries', task: 'Publish', workflow: 'quick-task', steps: [] });
      writer.flush();
      artifactId = (await publish(run.id)).id;
      setRunStatus(writer, run.id, RUN_STATUS.done);
      writer.flush();
    } finally { writer.close(); }
    expect((await page()).reports.map(a => a.id)).toContain(artifactId);
  });

  it('indexes only the settling task and ignores archive events from finished tasks', async () => {
    const settled = task('Settling'), active = task('Still running');
    reportsIndex(store).start(); await page();
    const a = await publish(settled.id), b = await publish(active.id);
    setRunStatus(store, settled.id, RUN_STATUS.done); store.flush();
    // The public serialized barrier completes the settlement work without including live tasks.
    await reportsIndex(store).reconcile(false);
    const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try {
      expect(raw.prepare('SELECT id FROM artifacts').all().map(row => row.id)).toEqual([a.id]);
      store.updateRun(settled.id, { archived: true }); store.flush();
      await reportsIndex(store).reconcile(false);
      expect(raw.prepare('SELECT id FROM artifacts WHERE id = ?').get(b.id)).toBeUndefined();
    } finally { raw.close(); }
  });

  it('paginates newest first with stable ties and searches title, file name, and the shared source-task predicate', async () => {
    const run = task('Distinct task');
    const a = await publish(run.id, 'budget.html', 'Income');
    const b = await publish(run.id, 'plan.html', 'Forecast');
    const first = await page('?limit=1');
    expect(first.total).toBe(2); expect(first.nextCursor).toBeTruthy();
    const second = await page(`?limit=1&before=${first.nextCursor}`);
    expect(new Set([first.reports[0]!.id, second.reports[0]!.id])).toEqual(new Set([a.id, b.id]));
    expect(second.nextCursor).toBeNull();
    expect((await page('?q=forecast')).reports.map(r => r.id)).toEqual([b.id]);
    expect((await page('?q=budget')).reports.map(r => r.id)).toEqual([a.id]);
    expect((await page('?q=distinct')).total).toBe(2);
    expect((await page('?q=quick-task')).total).toBe(2);
    expect((await page('?q=absent')).total).toBe(0);
  });

  it('fills a page past missing content and lists from summaries without full-record reads', async () => {
    const run = task();
    await publish(run.id, 'first.html'); await publish(run.id, 'second.html');
    await publish(run.id, 'third.html');
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush();
    await page();
    const initial = await page('?limit=1');
    const missing = initial.reports[0]!;
    rmSync(join(artifactDirectory(dataDir, run.id), missing.id, 'content'));
    const getRun = vi.spyOn(store, 'getRun');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const next = await page('?limit=1');
      expect(next.reports).toHaveLength(1);
      expect(next.reports[0]!.id).not.toBe(missing.id);
      expect(next.total).toBe(3); expect(next.nextCursor).toBeTruthy();
      expect((await page('?limit=1')).total).toBe(2);
      expect(getRun).not.toHaveBeenCalled();
    } finally { getRun.mockRestore(); warning.mockRestore(); }
  });

  it('skips an unreadable summary without losing its cached snapshot, then lists it after repair', async () => {
    const broken = task('Broken'), good = task('Readable');
    const cached = await publish(broken.id, 'broken.html');
    const artifact = await publish(good.id, 'good.html');
    for (const run of [broken, good]) setRunStatus(store, run.id, RUN_STATUS.done);
    store.flush(); await page();
    const raw = new DatabaseSync(join(dataDir, 'runs.db'));
    const summary = raw.prepare('SELECT summary FROM runs WHERE id = ?').get(broken.id)!.summary;
    raw.prepare('UPDATE runs SET summary = ? WHERE id = ?').run('{broken', broken.id);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await page('?limit=1');
      expect(result.reports).toEqual([expect.objectContaining({ id: artifact.id, taskTitle: 'Readable' })]);
      expect(result.total).toBe(1); expect(result.nextCursor).toBeNull();
      expect(warning).toHaveBeenCalledExactlyOnceWith(`${logPrefix()} Report source task could not be read: ${broken.id}`);
      expect(raw.prepare('SELECT id FROM artifacts WHERE id = ?').get(cached.id)).toBeTruthy();
      raw.prepare('UPDATE runs SET summary = ? WHERE id = ?').run(summary!, broken.id);
      const open = vi.spyOn(fs, 'open');
      expect((await page()).reports.map(row => row.id)).toContain(cached.id);
      expect(open.mock.calls.filter(([path]) => String(path).endsWith('/metadata.json'))).toHaveLength(0); // Page checks validate directories; no metadata rescan was needed.
    } finally { raw.close(); }
  });

  it('counts readable matching summaries beyond lookahead consistently across cursor pages', async () => {
    const broken = task('Broken'), good = task('Readable');
    await publish(broken.id, 'old.html', 'Matching report');
    const first = await publish(good.id, 'first.html', 'Matching report');
    const second = await publish(good.id, 'second.html', 'Matching report');
    for (const run of [broken, good]) setRunStatus(store, run.id, RUN_STATUS.done);
    store.flush(); await page();
    const raw = new DatabaseSync(join(dataDir, 'runs.db'));
    try {
      // Put the unreadable summary strictly beyond the first page's lookahead.
      raw.prepare('UPDATE artifacts SET created_at = ? WHERE run_id = ?').run('2000-01-01T00:00:00.000Z', broken.id);
      raw.prepare('UPDATE runs SET summary = ? WHERE id = ?').run('{broken', broken.id);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const getRun = vi.spyOn(store, 'getRun'), stat = vi.spyOn(fs, 'lstat');
      for (const search of ['', '&q=matching', '&q=readable']) {
        const one = await page(`?limit=1${search}`);
        expect(one.total).toBe(2); expect(one.nextCursor).toBeTruthy();
        const two = await page(`?limit=1${search}&before=${one.nextCursor}`);
        expect(two.total).toBe(one.total); expect(two.nextCursor).toBeNull();
        expect(new Set([...one.reports, ...two.reports].map(row => row.id))).toEqual(new Set([first.id, second.id]));
      }
      expect((await page('?q=first.html')).total).toBe(1);
      expect((await page('?q=broken')).total).toBe(0);
      expect(getRun).not.toHaveBeenCalled();
      expect(stat.mock.calls.filter(([path]) => String(path).endsWith('/content'))).toHaveLength(10); // Only page candidates, including lookahead; count never checks content.
    } finally { raw.close(); }
  });

  it('preserves cached reports and retries a directory redirected to an empty target', async () => {
    const run = task(); const artifact = await publish(run.id);
    await page();
    const directory = artifactDirectory(dataDir, run.id), saved = directory + '-saved';
    const empty = join(root, 'empty'); mkdirSync(empty);
    renameSync(directory, saved); symlinkSync(empty, directory, 'dir');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush();
    await reportsIndex(store).reconcile(false, run.id);
    const raw = new DatabaseSync(join(dataDir, 'runs.db'));
    try {
      raw.prepare('DELETE FROM meta WHERE key = ?').run(REPORTS_BACKFILL_KEY);
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
      expect(await readArtifact(artifactDirectory(dataDir, run.id), run.id, artifact.id)).toBeNull();
      expect(raw.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifact.id)).toBeTruthy();
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(REPORTS_BACKFILL_KEY)).toBeUndefined();
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeTruthy();
      rmSync(directory); writeFileSync(directory, 'not a directory');
      await reportsIndex(store).backfill();
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(REPORTS_BACKFILL_KEY)).toBeUndefined();
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
      rmSync(directory); renameSync(saved, directory);
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeUndefined();
    } finally { raw.close(); }
  });

  it('keeps redirected cached metadata reachable while refusing same-sized outside content', async () => {
    const run = task(); const artifact = await publish(run.id);
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush(); await page();
    const directory = join(dataDir, 'runs'), saved = directory + '-saved', outside = join(root, 'outside');
    cpSync(directory, outside, { recursive: true });
    renameSync(directory, saved); symlinkSync(outside, directory, 'dir');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try {
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
      expect(await readArtifact(artifactDirectory(dataDir, run.id), run.id, artifact.id)).toBeNull();
      expect(raw.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifact.id)).toBeTruthy();
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeTruthy();
      rmSync(directory); renameSync(saved, directory);
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
    } finally { raw.close(); }
  });

  it('keeps cached reports and a durable retry marker after metadata I/O failure, then indexes a recovered publication', async () => {
    const run = task(); const cached = await publish(run.id);
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush(); await page();
    const recovered = await publish(run.id, 'recovered.html');
    const actualOpen = fs.open;
    const fault = vi.spyOn(fs, 'open').mockImplementation((...args) => {
      if (String(args[0]).endsWith('/metadata.json')) return Promise.reject(Object.assign(new Error('temporarily unreadable'), { code: 'EIO' }));
      return actualOpen(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await reportsIndex(store).reconcile(false, run.id);
    const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try {
      expect(raw.prepare('SELECT id FROM artifacts WHERE run_id = ?').all(run.id)).toEqual([{ id: cached.id }]);
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeTruthy();
      expect((await page()).reports.map(row => row.id)).toEqual([cached.id]);
      fault.mockRestore();
      expect(new Set((await page()).reports.map(row => row.id))).toEqual(new Set([cached.id, recovered.id]));
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeUndefined();
    } finally { raw.close(); }
  });

  it('leaves backfill incomplete after an indeterminate scan and retries after restart', async () => {
    const run = task(); const artifact = await publish(run.id);
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush();
    const actualOpen = fs.open;
    const fault = vi.spyOn(fs, 'open').mockImplementation((...args) => {
      if (String(args[0]).endsWith('/metadata.json')) return Promise.reject(Object.assign(new Error('temporarily unreadable'), { code: 'EACCES' }));
      return actualOpen(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await reportsIndex(store).backfill();
    const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try { expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(REPORTS_BACKFILL_KEY)).toBeUndefined(); }
    finally { raw.close(); }
    fault.mockRestore(); store.close(); store = RunStore.open(dataDir);
    expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
    const repaired = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try { expect(repaired.prepare('SELECT value FROM meta WHERE key = ?').get(REPORTS_BACKFILL_KEY)).toBeTruthy(); }
    finally { repaired.close(); }
  });

  it('keeps a report when its directory or content check is indeterminate and retries later', async () => {
    const run = task(); const artifact = await publish(run.id);
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush(); await page();
    const directoryFault = vi.spyOn(fs, 'opendir').mockRejectedValue(Object.assign(new Error('busy directory'), { code: 'EACCES' }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await reportsIndex(store).reconcile(false, run.id);
    expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
    directoryFault.mockRestore(); await page();
    const actualStat = fs.lstat;
    const contentFault = vi.spyOn(fs, 'lstat').mockImplementation((...args) => {
      if (String(args[0]).endsWith('/content')) return Promise.reject(Object.assign(new Error('busy content'), { code: 'EIO' }));
      return actualStat(...args);
    });
    expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
    contentFault.mockRestore();
    expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
  });

  it.each(['bad metadata', 'foreign metadata', 'size mismatch'])('drops a known-invalid snapshot: %s', async kind => {
    const run = task(); const artifact = await publish(run.id); await page();
    const directory = join(artifactDirectory(dataDir, run.id), artifact.id);
    const metadata = join(directory, 'metadata.json');
    if (kind === 'bad metadata') writeFileSync(metadata, '{broken');
    else if (kind === 'foreign metadata') writeFileSync(metadata, JSON.stringify({ ...JSON.parse(readFileSync(metadata, 'utf8')), runId: randomUUID() }));
    else writeFileSync(join(directory, 'content'), 'changed size');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await page()).reports).toEqual([]);
    const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try { expect(raw.prepare('SELECT id FROM artifacts WHERE id = ?').get(artifact.id)).toBeUndefined(); }
    finally { raw.close(); }
  });

  it('never indexes foreign artifact directories or exposes reports through an unknown project', async () => {
    const foreign = RunStore.open(join(root, 'other'));
    try {
      const run = foreign.createRun({ title: 'Foreign', task: 'secret', workflow: 'quick-task', steps: [] });
      await publish(run.id);
      expect((await page()).reports).toEqual([]);
      expect((await get('', 'other')).status).toBe(404);
    } finally { foreign.close(); }
  });

  it('reports missing content and drops its cache row instead of serving it', async () => {
    const run = task(); const artifact = await publish(run.id);
    await page(); setRunStatus(store, run.id, RUN_STATUS.done); store.flush();
    await reportsIndex(store).reconcile();
    rmSync(join(artifactDirectory(dataDir, run.id), artifact.id, 'content'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await page()).reports).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(`Report missing or deleted: ${run.id}/${artifact.id}`));
    } finally { warning.mockRestore(); }
  });

  it('removes cache rows atomically with history deletion and cannot restore them during reconciliation', async () => {
    const run = task(); await publish(run.id); await page();
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush();
    await reportsIndex(store).reconcile();
    expect(store.deleteRun(run.id)).toBe(true); store.flush();
    const db = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try {
      expect(db.prepare('SELECT id FROM runs WHERE id = ?').get(run.id)).toBeUndefined();
      expect(db.prepare('SELECT id FROM artifacts WHERE run_id = ?').all(run.id)).toEqual([]);
    } finally { db.close(); }
    expect((await page()).total).toBe(0);
  });

  it('includes owned workers and names the worker as the source task', async () => {
    const parent = task('Parent');
    store.updateRun(parent.id, { delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } });
    const id = randomUUID();
    const worker = store.createOwnedRun({ title: 'Worker report', task: 'Analyze', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(), {
      role: 'worker', parentRunId: parent.id, permissions: [],
      workspace: { ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path: join(root, 'worker'), branch: `cez/${id.slice(0, 8)}`, baselineSha: 'a'.repeat(40) },
    }, 'b'.repeat(64));
    const artifact = await publish(worker.id);
    expect((await page()).reports).toEqual([expect.objectContaining({ id: artifact.id, runId: worker.id, taskTitle: 'Worker report' })]);
  });

  it('starts backfill without waiting on its completion', () => {
    const backfill = vi.spyOn(reportsIndex(store), 'backfill').mockReturnValue(new Promise(() => {}));
    expect(reportsIndex(store).start()).toBeUndefined();
    expect(backfill).toHaveBeenCalledOnce();
    backfill.mockRestore();
  });

  it('refuses an unavailable store instead of reporting an empty project', async () => {
    const unavailable = RunStore.unavailable(dataDir, new RunStoreOpenError('corrupt', join(dataDir, 'runs.db'), 'Run history is damaged'));
    const app = createApp({ home: testHome(), repoRoot: root, store: unavailable, manager: {} as RunManager, version: 'test' });
    const response = await apiRequest(app, '/api/v1/p/default/reports');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Run history is damaged') });
  });

  it('backfills through a trusted data-root ancestor alias while preserving below-root redirect checks', async () => {
    const run = task(); const artifact = await publish(run.id);
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush(); store.close();
    const alias = root + '-alias'; symlinkSync(root, alias, 'dir');
    try {
      dataDir = join(alias, '.ai/cezar'); store = RunStore.open(dataDir);
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
      const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
      try { expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(REPORTS_BACKFILL_KEY)).toBeTruthy(); }
      finally { raw.close(); }
      const runs = join(dataDir, 'runs'), saved = runs + '-saved', empty = join(root, 'empty-alias');
      mkdirSync(empty); renameSync(runs, saved); symlinkSync(empty, runs, 'dir');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await reportsIndex(store).reconcile(false, run.id);
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
      expect(await readArtifact(artifactDirectory(dataDir, run.id), run.id, artifact.id)).toBeNull();
      rmSync(runs); renameSync(saved, runs);
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
    } finally { store.close(); rmSync(alias); dataDir = join(root, '.ai/cezar'); store = RunStore.open(dataDir); }
  });

  it('keeps an indeterminate row reachable and all cursor pages complete before and after recovery', async () => {
    const run = task();
    for (const name of ['first.html', 'second.html', 'third.html']) await publish(run.id, name);
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush();
    const baseline = await page();
    const target = baseline.reports[0]!;
    const actual = fs.lstat;
    const fault = vi.spyOn(fs, 'lstat').mockImplementation((...args) => {
      if (String(args[0]).endsWith('/content') && realpathSync(String(args[0])) === join(artifactDirectory(dataDir, run.id), target.id, 'content')) return Promise.reject(Object.assign(new Error('temporary stat failure'), { code: 'EIO' }));
      return actual(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scan = async () => {
      const reports = []; let before: string | null = null;
      do {
        const next = await page(`?limit=1${before ? '&before=' + before : ''}`);
        expect(next.total).toBe(3); expect(next.reports).toHaveLength(1);
        reports.push(...next.reports.map(row => row.id)); before = next.nextCursor;
      } while (before);
      return reports;
    };
    expect(await scan()).toEqual(baseline.reports.map(row => row.id));
    const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try { expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeTruthy(); }
    finally { raw.close(); }
    fault.mockRestore();
    expect(await scan()).toEqual(baseline.reports.map(row => row.id));
    expect(baseline.reports.map(row => row.id)).toContain(target.id);
  });

  it.each(['directory entries', 'artifact count', 'metadata bytes', 'file bytes', 'task bytes'])('retains the full cache and retry state after exceeding the store cap: %s', async cap => {
    const run = task(); const artifact = await publish(run.id);
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush(); await page();
    const directory = artifactDirectory(dataDir, run.id), entry = join(directory, artifact.id);
    const metadata = JSON.parse(readFileSync(join(entry, 'metadata.json'), 'utf8'));
    const added: string[] = [];
    if (cap === 'directory entries') {
      for (let i = 0; i < 1024; i++) {
        const file = join(directory, `junk-${i}`); writeFileSync(file, ''); added.push(file);
      }
    } else if (cap === 'artifact count' || cap === 'task bytes') {
      for (let i = 0; i < (cap === 'artifact count' ? 64 : 7); i++) {
        const id = randomUUID(), copy = join(directory, id); cpSync(entry, copy, { recursive: true }); added.push(copy);
        const size = cap === 'task bytes' ? 10 * 1024 * 1024 : metadata.size;
        if (cap === 'task bytes') truncateSync(join(copy, 'content'), size);
        writeFileSync(join(copy, 'metadata.json'), JSON.stringify({ ...metadata, id, size }));
      }
    } else if (cap === 'metadata bytes') writeFileSync(join(entry, 'metadata.json'), ' '.repeat(32 * 1024 + 1));
    else truncateSync(join(entry, 'content'), 10 * 1024 * 1024 + 1);
    const raw = new DatabaseSync(join(dataDir, 'runs.db'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      raw.prepare('DELETE FROM meta WHERE key = ?').run(REPORTS_BACKFILL_KEY);
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
      expect(raw.prepare('SELECT id FROM artifacts WHERE run_id = ?').all(run.id)).toEqual([{ id: artifact.id }]);
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeTruthy();
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(REPORTS_BACKFILL_KEY)).toBeUndefined();
      for (const path of added) rmSync(path, { recursive: true });
      writeFileSync(join(entry, 'metadata.json'), JSON.stringify(metadata));
      writeFileSync(join(entry, 'content'), '<title>Quarterly results</title><p>report</p>');
      expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeUndefined();
      expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(REPORTS_BACKFILL_KEY)).toBeTruthy();
    } finally { raw.close(); }
  });

  it('retains a cached row and retries when its content becomes a symlink', async () => {
    const run = task(); const artifact = await publish(run.id);
    setRunStatus(store, run.id, RUN_STATUS.done); store.flush(); await page();
    const content = join(artifactDirectory(dataDir, run.id), artifact.id, 'content'), saved = content + '-saved';
    renameSync(content, saved); symlinkSync(saved, content);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
    expect(await readArtifact(artifactDirectory(dataDir, run.id), run.id, artifact.id)).toBeNull();
    const raw = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try { expect(raw.prepare('SELECT value FROM meta WHERE key = ?').get(`reports-dirty:${run.id}`)).toBeTruthy(); }
    finally { raw.close(); }
    rmSync(content); renameSync(saved, content);
    expect((await page()).reports.map(row => row.id)).toEqual([artifact.id]);
  });

  it('ignores live legacy task IDs and clears their impossible artifact retry markers', async () => {
    const good = task(), legacy = task('Legacy');
    const report = await publish(good.id);
    setRunStatus(store, legacy.id, RUN_STATUS.running); store.flush(); store.close();
    const raw = new DatabaseSync(join(dataDir, 'runs.db'));
    try {
      raw.prepare("UPDATE runs SET id = ?, data = json_set(data, '$.id', ?), summary = json_set(summary, '$.id', ?) WHERE id = ?").run('run-1', 'run-1', 'run-1', legacy.id);
      raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('reports-dirty:run-1', '1');
    } finally { raw.close(); }
    store = RunStore.open(dataDir);
    expect((await page()).reports.map(row => row.id)).toEqual([report.id]);
    const read = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try { expect(read.prepare('SELECT value FROM meta WHERE key = ?').get('reports-dirty:run-1')).toBeUndefined(); }
    finally { read.close(); }
  });

  it('accepts the shared maximum search length and refuses a longer query', async () => {
    expect((await get(`?q=${'a'.repeat(REPORTS_QUERY_MAX)}`)).status).toBe(200);
    expect((await get(`?q=${'a'.repeat(REPORTS_QUERY_MAX + 1)}`)).status).toBe(400);
  });

  it('validates query shapes and opaque cursors', async () => {
    for (const query of ['?limit=0', '?limit=101', '?limit=no', '?extra=1', '?before=invalid']) expect((await get(query)).status).toBe(400);
  });
});
