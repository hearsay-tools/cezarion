import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { RUN_IN_USE_ELSEWHERE, RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp, projectRouteManifest } from './server.ts';

/**
 * Run controls when two cezar processes share a project (#779, plan step 3). The other process is
 * a second store in this one: its claims carry another session. A real manager with no slots, so
 * nothing spawns.
 */
describe('controls on a run another cezar process owns', () => {
  let repoRoot: string;
  let dataDir: string;
  let owner: RunStore;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;
  let runId: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-run-ownership-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    owner = RunStore.open(dataDir, { keepLive: true });
    runId = owner.createRun({ title: 'theirs', workflow: 'quick-task', task: 'theirs', steps: [] }).id;
    owner.flush();
    store = RunStore.open(dataDir, { keepLive: true });
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    manager.dispose();
    store.close();
    owner.close();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** Every route that is not a read of one run, from the app's own registrations, so a route
   *  added later is walked too. */
  const controls = () => projectRouteManifest(app).filter((route) =>
    route.method !== 'GET' && (route.path === '/runs/:id' || route.path.startsWith('/runs/:id/')));

  it('answers 409 { error } on every control route, changes nothing, and still answers reads', async () => {
    const routes = controls();
    // The family as it stands: cancel, continue, finish, messages, queued messages, archive, pin,
    // notify, read, unread, PATCH, DELETE, auto-resume, remove-worktree, pr, git, open-in, …
    expect(routes.length).toBeGreaterThanOrEqual(20);
    const before = readPersistedRuns(dataDir);
    const answers: Array<{ route: string; status: number; body: { error?: string } }> = [];
    for (const route of routes) {
      const path = `/api/v1${route.path.replace(':id', runId).replace(/:[A-Za-z]+/g, 'x')}`;
      const response = await apiRequest(app, path, { method: route.method, headers: { 'content-type': 'application/json' }, body: '{}' });
      answers.push({ route: `${route.method} ${route.path}`, status: response.status, body: await response.json() as { error?: string } });
    }
    expect(answers.filter((answer) => answer.status !== 409 || answer.body.error !== RUN_IN_USE_ELSEWHERE)).toEqual([]);
    expect(readPersistedRuns(dataDir)).toEqual(before);
    expect(store.heldIds()).toEqual([]);

    const detail = await apiRequest(app, `/api/v1/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { title: string }).title).toBe('theirs');
    const list = await apiRequest(app, '/api/v1/run-summaries');
    expect(((await list.json()) as Array<{ id: string }>).map((run) => run.id)).toEqual([runId]);
  });

  it('adopts a run whose owner died, recovers it, then applies the control', async () => {
    // The owner crashed: its claim is still there, under a session no live process has open.
    const raw = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
    raw.prepare("UPDATE run_claims SET session = 'crashed-owner'").run();
    raw.close();
    expect(store.runOwnership(runId)).toBe('orphaned');

    const response = await apiRequest(app, `/api/v1/runs/${runId}/cancel`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
    expect(store.getRun(runId)?.status).toBe('cancelled');
    store.flush();
    expect(readPersistedRuns(dataDir).find((run) => run.id === runId)).toMatchObject({ status: 'cancelled' });
    // Settled and let go: nobody claims it now.
    expect(store.runOwnership(runId)).toBe('free');
  });

  it('a control on its own runs is not refused', async () => {
    const mine = store.createRun({ title: 'mine', workflow: 'quick-task', task: 'mine', steps: [] });
    const response = await apiRequest(app, `/api/v1/runs/${mine.id}/pin`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { pinned?: boolean }).pinned).toBe(true);
  });
});
