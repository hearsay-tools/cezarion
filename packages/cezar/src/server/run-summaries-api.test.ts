import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiRunSchema, runSummarySchema } from '@open-mercato/cezar-contract';
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
});
