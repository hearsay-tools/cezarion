import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { GithubData } from './forge/types.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * The paged GitHub list and its after-paint hydration (hearsay-tools/cezarion#1183), driven
 * through `CEZ_DRY_RUN=1` so no `gh` is touched: `GET /api/v1/github` pages the mock catalog with
 * per-side cursors, and `GET /api/v1/github/comment-counts` answers the counts the list defers.
 * The gh-shelling and degrade paths live in the driver; here we prove the route wiring and the
 * query gates.
 */
describe('the paged github list and comment counts API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevDryRun = process.env.CEZ_DRY_RUN;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });
  afterAll(() => {
    if (prevDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = prevDryRun;
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghcounts-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('answers deferred comment counts from the dry-run catalog', async () => {
    const res = await apiRequest(app, '/api/v1/github/comment-counts?kind=issue&numbers=142,139');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, counts: { 142: 3, 139: 1 } });
  });

  it.each([
    ['a zero', 'kind=issue&numbers=0'],
    ['101 numbers', `kind=issue&numbers=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`],
    ['a missing kind', 'numbers=1'],
  ])('400s on %s', async (_name, query) => {
    const res = await apiRequest(app, `/api/v1/github/comment-counts?${query}`);
    expect(res.status).toBe(400);
  });

  it('answers the project alias byte-identically', async () => {
    const path = '/github/comment-counts?kind=pr&numbers=124,128';
    const plain = await (await apiRequest(app, `/api/v1${path}`)).text();
    expect(await (await apiRequest(app, `/api/v1/p/default${path}`)).text()).toBe(plain);
  });

  it('pages the list with a cursor per side, exact totals and no overlap', async () => {
    const all = (await (await apiRequest(app, '/api/v1/github?limit=1000')).json()) as GithubData;
    const first = await apiRequest(app, '/api/v1/github?limit=2');
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as GithubData;
    expect(page1.issues).toHaveLength(2);
    expect(page1.issuesTotal).toBe(all.issues.length);
    expect(page1.commentsDeferred).toBe(true);
    expect(typeof page1.issuesNextCursor).toBe('string');
    const page2 = (await (await apiRequest(app,
      `/api/v1/github?limit=2&issuesCursor=${page1.issuesNextCursor}&prsDone=1`)).json()) as GithubData;
    expect(page2.prs).toEqual([]);
    const seen = [...page1.issues, ...page2.issues].map((i) => i.number);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all.issues.slice(0, seen.length).map((i) => i.number));
  });

  it('400s on a done side that also carries its cursor', async () => {
    const res = await apiRequest(app, '/api/v1/github?issuesDone=1&issuesCursor=x');
    expect(res.status).toBe(400);
  });
});
