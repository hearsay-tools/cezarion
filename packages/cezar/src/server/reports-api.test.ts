import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportsResponseSchema } from '@open-mercato/cezar-contract/reports';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { artifactDirectory, publishArtifact } from '../artifacts/store.ts';
import { REPORTS_BACKFILL_KEY } from '../artifacts/reports-index.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('project reports', () => {
  let root: string, dataDir: string, store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-reports-'));
    dataDir = join(root, '.ai/cezar');
    store = RunStore.open(dataDir);
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const task = (title = 'Source task') => store.createRun({ title, workflow: 'quick-task', task: 'Searchable source prompt', steps: [] });
  const publish = async (id: string, name = 'analysis.html', title = 'Quarterly results') => {
    const source = join(root, name); writeFileSync(source, `<title>${title}</title><p>report</p>`);
    return publishArtifact(artifactDirectory(dataDir, id), id, source);
  };
  const get = (query = '', project = 'default') => apiRequest(createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' }), `/api/v1/p/${project}/reports${query}`);
  const page = async (query = '') => reportsResponseSchema.parse(await (await get(query)).json());

  it('backfills HTML from archived and terminal tasks, records completion, and preserves files after worktree removal', async () => {
    const run = task();
    const artifact = await publish(run.id);
    await publish(run.id, 'notes.txt');
    store.updateRun(run.id, { status: RUN_STATUS.done, archived: true, worktreeReclaimedAt: new Date().toISOString() });
    expect((await page()).reports).toEqual([expect.objectContaining({ id: artifact.id, title: 'Quarterly results', taskTitle: 'Source task', taskStatus: 'done' })]);
    const db = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
    try { expect(db.prepare('SELECT value FROM meta WHERE key = ?').get(REPORTS_BACKFILL_KEY)).toBeTruthy(); }
    finally { db.close(); }
  });

  it('reconciles publications made by live tasks after backfill and on committed settlement without a query', async () => {
    const run = task();
    store.reports.start();
    await page();
    const first = await publish(run.id);
    expect((await page()).reports.map(a => a.id)).toContain(first.id);
    const second = await publish(run.id, 'second.htm');
    store.updateRun(run.id, { status: RUN_STATUS.done });
    store.flush();
    // Wait for the settlement listener's serialized work, without invoking list/reconcile.
    await vi.waitFor(() => {
      const db = new DatabaseSync(join(dataDir, 'runs.db'), { readOnly: true });
      try { expect(db.prepare('SELECT id FROM artifacts WHERE id = ?').get(second.id)).toBeTruthy(); }
      finally { db.close(); }
    });
  });

  it('reconciles a run that was live in another process and settled between shelf queries', async () => {
    await page();
    const writer = RunStore.open(dataDir, { keepLive: true });
    let artifactId: string;
    try {
      const run = writer.createRun({ title: 'Between queries', task: 'Publish', workflow: 'quick-task', steps: [] });
      writer.flush();
      artifactId = (await publish(run.id)).id;
      writer.updateRun(run.id, { status: RUN_STATUS.done });
      writer.flush();
    } finally { writer.close(); }
    expect((await page()).reports.map(a => a.id)).toContain(artifactId);
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
    await page(); store.updateRun(run.id, { status: RUN_STATUS.done }); store.flush();
    await store.reports.reconcile();
    rmSync(join(artifactDirectory(dataDir, run.id), artifact.id, 'content'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await page()).reports).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(`Report missing or deleted: ${run.id}/${artifact.id}`));
    } finally { warning.mockRestore(); }
  });

  it('removes cache rows atomically with history deletion and cannot restore them during reconciliation', async () => {
    const run = task(); await publish(run.id); await page();
    store.updateRun(run.id, { status: RUN_STATUS.done }); store.flush();
    await store.reports.reconcile();
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
    const backfill = vi.spyOn(store.reports, 'backfill').mockReturnValue(new Promise(() => {}));
    expect(store.reports.start()).toBeUndefined();
    expect(backfill).toHaveBeenCalledOnce();
    backfill.mockRestore();
  });

  it('validates query shapes and opaque cursors', async () => {
    for (const query of ['?limit=0', '?limit=101', '?limit=no', '?extra=1', '?before=invalid']) expect((await get(query)).status).toBe(400);
  });
});
