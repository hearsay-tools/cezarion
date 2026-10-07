import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiRunSchema, archivedRunsResponseSchema, runSummarySchema } from '@open-mercato/cezar-contract';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `GET /api/v1/run-summaries` (#817) — the slim list the cockpit and `cez task list`/`watch`
 * read instead of every full record. Same runs, same order as `GET /runs`; none of the
 * detail-only fields.
 */
describe('run summaries API', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-run-summaries-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-run-summaries-repo-'));
    process.env.CEZ_HOME = home;
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const app = () =>
    createApp({ repoRoot, store, manager: { finishBlockedReason: () => 'no open session' } as unknown as RunManager, version: '0.0.0-test' });

  const getJson = async (path: string): Promise<unknown> => {
    const res = await apiRequest(app(), path);
    expect(res.status).toBe(200);
    return res.json();
  };

  it('answers the same runs in the same order as GET /runs, archived included, without detail fields', async () => {
    const planned = store.createRun({
      title: 'Planned', workflow: '(planned)', task: 'a long prompt',
      steps: [{ id: 'a', name: 'Fix bug', kind: 'agent' }],
    });
    store.updateRun(planned.id, { createdAt: '2026-10-01T10:00:00Z', systemPrompt: 'be brief' });
    const archived = store.createRun({ title: 'Old', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(archived.id, { createdAt: '2026-10-02T10:00:00Z', archived: true });

    const full = apiRunSchema.array().parse(await getJson('/api/v1/runs'));
    const summaries = runSummarySchema.array().parse(await getJson('/api/v1/run-summaries'));

    expect(summaries.map((run) => run.id)).toEqual(full.map((run) => run.id));
    expect(summaries.find((run) => run.id === archived.id)?.archived).toBe(true);
    expect(summaries.find((run) => run.id === planned.id)?.workflowLabel).toBe('Fix bug');
    const raw = (await getJson('/api/v1/run-summaries')) as Record<string, unknown>[];
    for (const row of raw) {
      for (const key of ['task', 'steps', 'systemPrompt', 'agentInputs', 'workflowDef']) expect(row).not.toHaveProperty(key);
    }
  });

  it('answers byte-identically under the project-scoped default alias', async () => {
    store.createRun({ title: 'One', workflow: 'quick-task', task: 't', steps: [] });
    expect(await getJson('/api/v1/p/default/run-summaries')).toEqual(await getJson('/api/v1/run-summaries'));
  });
  describe('the window and the archived pages (#864)', () => {
    /** Minute `n` after a fixed start, so a larger `n` is newer. */
    const at = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString();
    const run = (id: string, n: number, over: Record<string, unknown> = {}) => ({
      id, title: `run ${id}`, workflow: 'quick-task', task: 't', status: 'done', createdAt: at(n),
      finishedAt: at(n), tokensUsed: 0, archived: true, steps: [], ...over,
    });

    /** 1 unarchived root and 250 archived roots; arch-1 and arch-2 share a createdAt. */
    const reseed = (extra: unknown[] = []) => {
      store.close();
      const dataDir = join(repoRoot, '.ai/cezar');
      seedRuns(dataDir, [
        run('active', 0, { archived: false }),
        ...Array.from({ length: 250 }, (_, i) => run(`arch-${i + 1}`, i < 2 ? 10 : 10 + i, i === 0 ? { title: 'Bound the run lists', issueNumber: 864 } : {})),
        ...extra,
      ]);
      store = RunStore.open(dataDir);
    };

    const page = async (query: string) => archivedRunsResponseSchema.parse(await getJson(`/api/v1/run-summaries/archived${query}`));

    it('answers the window with ?archived=recent, and every run otherwise', async () => {
      reseed();
      const recent = runSummarySchema.array().parse(await getJson('/api/v1/run-summaries?archived=recent'));
      expect(recent.filter((row) => row.archived)).toHaveLength(200);
      expect(recent.map((row) => row.id)).toContain('active');
      expect(runSummarySchema.array().parse(await getJson('/api/v1/run-summaries'))).toHaveLength(251);
      expect(runSummarySchema.array().parse(await getJson('/api/v1/run-summaries?archived=all'))).toHaveLength(251);
      expect((await apiRequest(app(), '/api/v1/run-summaries?archived=bogus')).status).toBe(400);
    });

    it('pages every archived root exactly once, newest first, across tied createdAt', async () => {
      reseed();
      const seen: string[] = [];
      let cursor: string | null = '';
      let pages = 0;
      while (cursor !== null) {
        const body = await page(`?limit=50${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
        expect(body.total).toBe(250);
        seen.push(...body.runs.map((row) => row.id));
        cursor = body.nextCursor;
        pages++;
      }
      expect(pages).toBe(5);
      expect(new Set(seen).size).toBe(250);
      expect(seen).not.toContain('active');
      // arch-1 and arch-2 tie on createdAt and list in insertion order, last of all.
      expect(seen.slice(-2)).toEqual(['arch-1', 'arch-2']);
    });

    it('lists a run archived since the last save, and pages held runs too', async () => {
      reseed();
      const fresh = store.createRun({ title: 'fresh', workflow: 'quick-task', task: 't', steps: [] });
      store.setArchived(fresh.id, true);
      const first = await page('?limit=1');
      expect(first.runs.map((row) => row.id)).toEqual([fresh.id]);
      expect(first.total).toBe(251);
      const second = await page(`?limit=1&before=${encodeURIComponent(first.nextCursor!)}`);
      expect(second.runs.map((row) => row.id)).toEqual(['arch-250']);
    });

    it('filters by q and counts the matches', async () => {
      reseed();
      expect(await page('?q=bound%20lists')).toMatchObject({ runs: [{ id: 'arch-1' }], total: 1, nextCursor: null });
      expect(await page('?q=%23864')).toMatchObject({ runs: [{ id: 'arch-1' }], total: 1 });
    });

    it('refuses a malformed cursor and an out-of-range limit', async () => {
      reseed();
      for (const query of ['?before=garbage', '?before=eyJjIjoxfQ', '?limit=201', '?limit=0']) {
        const res = await apiRequest(app(), `/api/v1/run-summaries/archived${query}`);
        expect(res.status, query).toBe(400);
        expect(await res.json()).toHaveProperty('error');
      }
    });

    it('answers byte-identically under the project-scoped default alias', async () => {
      reseed();
      expect(await getJson('/api/v1/p/default/run-summaries/archived?limit=3')).toEqual(await getJson('/api/v1/run-summaries/archived?limit=3'));
    });
  });
});
