import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunStatus } from '@open-mercato/cezar-contract';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

import { takeRunExitViolations } from '../runs/run-exits.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { resolveForgeRoot, type ForgeFactory } from './forge/index.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `POST /runs/:id/pr` (Draft PR) settles the run done by the `draft-pr` exit (slice S4a of
 * .ai/specs/2026-11-03-run-store-owns-exits.md). The cockpit offers it on review and settled runs
 * (Task changes) and on a done, failed or cancelled run's branch (Not landed), so it meets review
 * and the settled statuses; none records a violation.
 */

const PR_URL = 'https://github.com/acme/demo/pull/777';
const FINISHED_AT = '2026-11-01T10:00:00.000Z';
let claims = 0;
let published = 0;
const forgeFactory: ForgeFactory = (root) => ({ ...resolveForgeRoot(root), createPR: async () => { published++; return { ok: true, url: PR_URL, dryRun: false }; } });
const manager = { isActive: () => false, claimForPublish: () => { claims++; return () => {}; } } as unknown as RunManager;

describe('the Draft PR route', () => {
  let dir: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    claims = 0;
    published = 0;
    dir = mkdtempSync(join(tmpdir(), 'cez-draft-pr-'));
    mkdirSync(join(dir, '.ai/cezar'), { recursive: true });
    mkdirSync(join(dir, 'worktree'));
    store = RunStore.open(join(dir, '.ai/cezar'));
    app = createApp({ home: testHome(), repoRoot: dir, store, manager, version: '0.0.0-test', forgeFactory });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    expect(takeRunExitViolations()).toEqual([]);
  });

  const seed = (status: RunStatus, finishedAt?: string) => {
    const id = store.createRun({ title: 'publish', task: 'publish', workflow: 'quick-task', steps: [] }).id;
    setRunStatus(store, id, status, { finishedAt, worktreePath: join(dir, 'worktree'), branch: 'cez/publish' });
    return id;
  };

  it('settles a review run done with the PR and a finishedAt', async () => {
    const id = seed(RUN_STATUS.review);
    const res = await apiRequest(app, `/api/v1/runs/${id}/pr`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(store.getRun(id)).toMatchObject({ status: RUN_STATUS.done, pullRequestUrl: PR_URL, finishedAt: expect.any(String) });
  });

  it.each([RUN_STATUS.done, RUN_STATUS.failed, RUN_STATUS.cancelled])('settles a %s run done, its finishedAt kept', async (status) => {
    const id = seed(status, FINISHED_AT);
    const res = await apiRequest(app, `/api/v1/runs/${id}/pr`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(store.getRun(id)).toMatchObject({ status: RUN_STATUS.done, pullRequestUrl: PR_URL, finishedAt: FINISHED_AT });
  });

  // Table B row B13 (S7): the cockpit offers no Draft PR on a usage-limit hold, and writing done on
  // it would silently drop the booked resume. The route refuses it before any write.
  it('refuses a usage-limit hold with 409 before any write', async () => {
    const id = seed(RUN_STATUS.waiting);
    store.updateRun(id, { autoResumeAt: '2099-01-01T00:00:00.000Z' });
    const before = structuredClone(store.getRun(id));
    const res = await apiRequest(app, `/api/v1/runs/${id}/pr`, { method: 'POST' });
    expect(res.status).toBe(409);
    // The hold's own way out is the thread's Don’t resume, which settles it failed; Stop may leave it.
    expect(await res.json()).toEqual({ error: 'run is waiting on a usage-limit hold — choose Don’t resume in the task’s usage-limit hint, then retry Draft PR' });
    expect(store.getRun(id)).toEqual(before);
    expect([claims, published]).toEqual([0, 0]);
  });
});
