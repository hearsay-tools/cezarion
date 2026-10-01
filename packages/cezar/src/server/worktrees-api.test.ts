import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnedWorkspace } from '../delegation/workspace.ts';
import { createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The worktree management panel API (#483 Phase 2). `GET /api/v1/worktrees` lists
 * materialized worktrees with disk usage + retention state; `POST
 * /api/v1/worktrees/reclaim` force-runs the enforcer. Both additive and
 * best-effort — never error.
 */
describe('the worktrees API', () => {
  let repoRoot: string;
  let cezHome: string;
  let store: RunStore;
  let app: Hono;
  let manager: RunManager;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(async () => {
    // `keep` now falls back to the workspace default, so pin CEZ_HOME at an
    // empty temp dir — the suite must never read the developer's real ~/.cezar.
    cezHome = mkdtempSync(join(tmpdir(), 'cez-wtapi-home-'));
    process.env.CEZ_HOME = cezHome;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-wtapi-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // A real manager: the reclaim routes claim through it, the same claim Continue is refused by.
    manager = new RunManager(store, repoRoot);
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  async function seed(
    id: string,
    status: 'done' | 'review' | 'running',
    finishedAt?: string,
  ): Promise<string> {
    const wt = await createWorktree(repoRoot, id, 'main');
    const rec = store.createRun({ title: `run ${id.slice(0, 4)}`, workflow: 'w', task: 't', steps: [] });
    store.updateRun(rec.id, { status, finishedAt, worktreePath: wt.path, branch: wt.branch });
    return rec.id;
  }

  const getWorktrees = async () =>
    (await (
      await apiRequest(app, '/api/v1/worktrees')
    ).json()) as {
      worktrees: Array<{
        runId: string;
        title: string;
        status: string;
        branch: string | null;
        sizeBytes: number | null;
        finishedAt: string | null;
        reclaimable: boolean;
        pastKeep: boolean;
      }>;
      totalBytes: number | null;
      keep: number;
    };

  it('lists materialized worktrees with sizes, the keep-limit, and a reclaimable flag', async () => {
    const doneId = await seed('11111111-1111-4111-8111-111111111111', 'done', '2026-07-01T00:00:00Z');
    const reviewId = await seed('22222222-2222-4222-8222-222222222222', 'review', '2026-07-02T00:00:00Z');
    const runningId = await seed('33333333-3333-4333-8333-333333333333', 'running');

    const body = await getWorktrees();
    expect(body.keep).toBe(10); // schema default
    expect(body.worktrees).toHaveLength(3);

    const byRun = Object.fromEntries(body.worktrees.map((w) => [w.runId, w]));
    // reclaimable flag matches the selector's rule: finished + has dir + not stamped.
    expect(byRun[doneId]!.reclaimable).toBe(true);
    expect(byRun[reviewId]!.reclaimable).toBe(false); // review is spared
    expect(byRun[runningId]!.reclaimable).toBe(false); // live work

    // Shape + real du sizes on this (POSIX) host.
    expect(byRun[doneId]!.branch).toMatch(/^cez\//);
    expect(typeof byRun[doneId]!.sizeBytes).toBe('number');
    expect(body.totalBytes).not.toBeNull();
  });

  it('reflects the configured keep-limit', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: 2 }), 'utf8');
    expect((await getWorktrees()).keep).toBe(2);
  });

  it('inherits the workspace default when the repo sets no retention of its own', async () => {
    writeFileSync(
      join(cezHome, 'config.json'),
      JSON.stringify({ resources: { worktreeRetentionDefault: 4 } }),
      'utf8',
    );
    expect((await getWorktrees()).keep).toBe(4);
    // A repo that sets its own still wins — the workspace value only seeds.
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: 2 }), 'utf8');
    expect((await getWorktrees()).keep).toBe(2);
  });

  it('POST /reclaim reclaims down to the limit and returns the reclaimed ids', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: 1 }), 'utf8');
    const oldId = await seed('44444444-4444-4444-8444-444444444444', 'done', '2026-07-01T00:00:00Z');
    const newId = await seed('55555555-5555-4555-8555-555555555555', 'done', '2026-07-09T00:00:00Z');
    const reviewId = await seed('77777777-7777-4777-8777-777777777777', 'review', '2026-06-01T00:00:00Z');

    // `pastKeep` names exactly the rows Reclaim now takes: the older finished one. The newest is
    // kept inside keep=1, and a review row is never past it however old it is.
    const listed = Object.fromEntries((await getWorktrees()).worktrees.map((w) => [w.runId, w.pastKeep]));
    expect(listed).toEqual({ [oldId]: true, [newId]: false, [reviewId]: false });

    const res = await apiRequest(app, '/api/v1/worktrees/reclaim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const { reclaimed } = (await res.json()) as { reclaimed: string[] };
    expect(reclaimed).toEqual([oldId]); // the oldest over the keep=1 budget

    // The reclaimed worktree drops out of the listing (its dir is gone).
    const body = await getWorktrees();
    expect(body.worktrees.map((w) => w.runId)).not.toContain(oldId);
  });

  it('POST /reclaim is a 200 no-op on empty state', async () => {
    const res = await apiRequest(app, '/api/v1/worktrees/reclaim', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reclaimed: [] });
  });

  it('GET returns an empty listing when there are no materialized worktrees', async () => {
    const body = await getWorktrees();
    expect(body.worktrees).toEqual([]);
    expect(body.totalBytes).toBe(0);
  });

  it('omits worktrees whose directory no longer exists on disk', async () => {
    const id = await seed('66666666-6666-4666-8666-666666666666', 'done', '2026-07-01T00:00:00Z');
    const wtPath = store.getRun(id)?.worktreePath as string;
    rmSync(wtPath, { recursive: true, force: true });
    expect(existsSync(wtPath)).toBe(false);
    expect((await getWorktrees()).worktrees.map((w) => w.runId)).not.toContain(id);
  });
  it('lists a finished worker as reclaimable and Reclaim now frees it when over keep (#575)', async () => {
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: 1 }), 'utf8');
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(parent.id, { status: 'done', finishedAt: '2026-07-09T00:00:00Z', delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    const oldWorkspace = await createOwnedWorkspace(repoRoot, randomUUID(), sha);
    const newWorkspace = await createOwnedWorkspace(repoRoot, randomUUID(), sha);
    const oldWorker = store.createOwnedRun({ title: 'old worker', task: 'worker', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(),
      { role: 'worker', parentRunId: parent.id, permissions: [], workspace: oldWorkspace }, 'a'.repeat(64));
    const newWorker = store.createOwnedRun({ title: 'new worker', task: 'worker', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(),
      { role: 'worker', parentRunId: parent.id, permissions: [], workspace: newWorkspace }, 'b'.repeat(64));
    store.updateRun(oldWorker.id, { status: 'done', finishedAt: '2026-07-01T00:00:00Z', worktreePath: oldWorkspace.path, branch: oldWorkspace.branch });
    store.updateRun(newWorker.id, { status: 'done', finishedAt: '2026-07-09T00:00:00Z', worktreePath: newWorkspace.path, branch: newWorkspace.branch });

    const listed = await getWorktrees();
    const byRun = Object.fromEntries(listed.worktrees.map((w) => [w.runId, w]));
    expect(byRun[oldWorker.id]?.reclaimable).toBe(true);
    expect(byRun[newWorker.id]?.reclaimable).toBe(true);

    const res = await apiRequest(app, '/api/v1/worktrees/reclaim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reclaimed: [oldWorker.id] });
    expect(existsSync(oldWorkspace.path)).toBe(false);
    expect(existsSync(newWorkspace.path)).toBe(true);
  });

  it('does not mark a finished worker reclaimable while its parent is live without a worktree dir', async () => {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(parent.id, {
      status: 'waiting',
      worktree: false,
      delegation: { role: 'root', permissions: ['spawn'], receipts: [] },
    });
    const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    const workspace = await createOwnedWorkspace(repoRoot, randomUUID(), sha);
    const worker = store.createOwnedRun(
      { title: 'worker', task: 'worker', workflow: 'quick-task', steps: [] },
      parent.id,
      randomUUID(),
      { role: 'worker', parentRunId: parent.id, permissions: [], workspace },
      'a'.repeat(64),
    );
    store.updateRun(worker.id, {
      status: 'done',
      finishedAt: '2026-07-01T00:00:00Z',
      worktreePath: workspace.path,
      branch: workspace.branch,
    });
    const listed = await getWorktrees();
    const byRun = Object.fromEntries(listed.worktrees.map((w) => [w.runId, w]));
    expect(byRun[worker.id]?.reclaimable).toBe(false);
    expect(listed.worktrees.map((w) => w.runId)).not.toContain(parent.id);
  });

  it('human deletion and worktree removal preserve worker and parent ownership evidence', async () => {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    store.updateRun(parent.id, { status: 'done', delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    const workspace = await createOwnedWorkspace(repoRoot, randomUUID(), sha);
    const worker = store.createOwnedRun({ title: 'worker', task: 'worker', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(),
      { role: 'worker', parentRunId: parent.id, permissions: [], workspace }, 'a'.repeat(64));
    store.updateRun(worker.id, { status: 'cancelled', worktreePath: workspace.path, branch: workspace.branch });
    store.appendEvent(worker.id, { type: 'note', message: 'preserved worker history' });
    for (const id of [worker.id, parent.id]) {
      expect((await apiRequest(app, `/api/v1/runs/${id}`, { method: 'DELETE' })).status).toBe(409);
      expect((await apiRequest(app, `/api/v1/runs/${id}/remove-worktree`, { method: 'POST' })).status).toBe(409);
    }
    expect(existsSync(workspace.path)).toBe(true);
    expect(store.readEvents(worker.id)).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'preserved worker history' })]));
    store.updateRun(worker.id, { delegation: { role: 'invalid' } });
    expect((await apiRequest(app, `/api/v1/runs/${worker.id}`, { method: 'DELETE' })).status).toBe(409);
    expect(existsSync(workspace.path)).toBe(true);
  });

  describe('POST /worktrees/:runId/reclaim (issue 08 §B4)', () => {
    const reclaimOne = (id: string) => apiRequest(app, `/api/v1/worktrees/${id}/reclaim`, { method: 'POST' });
    const branchExists = async (branch: string) =>
      run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot }).then(() => true, () => false);

    it('removes the directory, keeps the branch, and stamps worktreeReclaimedAt', async () => {
      const id = await seed(randomUUID(), 'done', '2026-07-01T00:00:00Z');
      const { worktreePath, branch } = store.getRun(id)!;
      const res = await reclaimOne(id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string; worktreeReclaimedAt: string };
      expect(body.runId).toBe(id);
      expect(existsSync(worktreePath!)).toBe(false);
      expect(await branchExists(branch!)).toBe(true);
      expect(store.getRun(id)?.worktreeReclaimedAt).toBe(body.worktreeReclaimedAt);
      // Reclaimed once is reclaimed: a second press is a 409, not a second stamp.
      expect((await reclaimOne(id)).status).toBe(409);
    });

    it('409s for a live run, a review run, and a run the manager still holds; 404s an unknown id', async () => {
      const live = await seed(randomUUID(), 'running');
      const review = await seed(randomUUID(), 'review', '2026-07-02T00:00:00Z');
      const held = await seed(randomUUID(), 'done', '2026-07-03T00:00:00Z');
      const isActive = manager.isActive.bind(manager);
      vi.spyOn(manager, 'isActive').mockImplementation((runId) => runId === held || isActive(runId));
      for (const id of [live, review, held]) {
        expect((await reclaimOne(id)).status).toBe(409);
        expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(true);
        expect(store.getRun(id)?.worktreeReclaimedAt).toBeUndefined();
      }
      expect((await reclaimOne(randomUUID())).status).toBe(404);
    });

    /** A finished run with an agent session, so Continue is admissible (the bundled mock serves it). */
    const resumable = async () => {
      const wt = await createWorktree(repoRoot, randomUUID(), 'main');
      const rec = store.createRun({ title: 'resumable', workflow: 'w', task: 't', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
      store.updateStep(rec.id, 'task', { status: 'done', sessionId: 'sess-1', backend: 'claude' });
      store.updateRun(rec.id, { status: 'done', finishedAt: '2026-07-01T00:00:00Z', worktreePath: wt.path, branch: wt.branch });
      return rec.id;
    };
    const savedDryRun = process.env.CEZ_DRY_RUN;
    beforeEach(() => { process.env.CEZ_DRY_RUN = '1'; });
    afterEach(() => {
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    });

    it('refuses a checkout with uncommitted work, in the row reclaim and in Reclaim now', async () => {
      writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ worktreeRetention: 1 }), 'utf8');
      const dirty = await seed(randomUUID(), 'done', '2026-07-01T00:00:00Z');
      const untracked = await seed(randomUUID(), 'done', '2026-07-02T00:00:00Z');
      await seed(randomUUID(), 'done', '2026-07-09T00:00:00Z');
      const pathOf = (id: string) => store.getRun(id)!.worktreePath!;
      writeFileSync(join(pathOf(dirty), 'base.txt'), 'edited after the run\n');
      writeFileSync(join(pathOf(untracked), 'notes.md'), 'only here\n');

      const res = await reclaimOne(dirty);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('1 uncommitted file');
      // Both are over keep=1, and both stay: their work is on no branch.
      const bulk = await apiRequest(app, '/api/v1/worktrees/reclaim', { method: 'POST' });
      expect(await bulk.json()).toEqual({ reclaimed: [] });
      for (const id of [dirty, untracked]) {
        expect(existsSync(pathOf(id))).toBe(true);
        expect(store.getRun(id)?.worktreeReclaimedAt).toBeUndefined();
      }
      expect(existsSync(join(pathOf(untracked), 'notes.md'))).toBe(true);
    });

    it('holds Continue off for the whole removal, and admits it again once the directory is gone', async () => {
      const id = await resumable();
      // Continue arrives the moment the handler holds its claim, while the removal is still awaiting.
      const claimed = new Promise<void>((resolve) => {
        const claim = manager.claimWorktreeReclaim.bind(manager);
        vi.spyOn(manager, 'claimWorktreeReclaim').mockImplementation((runId) => {
          const release = claim(runId);
          resolve();
          return release;
        });
      });
      const pending = reclaimOne(id);
      await claimed;
      expect(manager.continueRun(id, { text: 'go on' })).toEqual({ ok: false, error: expect.stringContaining('being reclaimed') });
      expect((await pending).status).toBe(200);
      expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(false);
      // Released: the next Continue is admitted, and re-materializes the reclaimed tree.
      expect(manager.continueRun(id, { text: 'go on' }).ok).toBe(true);
    });

    it('a reclaimed task can still open its draft PR: the checkout is restored first', async () => {
      // The checkout under the run's OWN id, as a real task has it — what re-materializing rebuilds.
      const id = store.createRun({ title: 'reclaimed', workflow: 'w', task: 't', steps: [] }).id;
      const wt = await createWorktree(repoRoot, id, 'main');
      store.updateRun(id, { status: 'done', finishedAt: '2026-07-01T00:00:00Z', worktreePath: wt.path, branch: wt.branch, baseBranch: 'main' });
      const { worktreePath, branch } = store.getRun(id)!;
      writeFileSync(join(worktreePath!, 'work.txt'), 'task work\n');
      await run('git', ['add', '-A'], { cwd: worktreePath! });
      await run('git', [...GIT_ID, 'commit', '-q', '-m', 'task work'], { cwd: worktreePath! });
      expect((await reclaimOne(id)).status).toBe(200);
      expect(existsSync(worktreePath!)).toBe(false);

      const res = await apiRequest(app, `/api/v1/runs/${id}/pr`, { method: 'POST' });
      expect(res.status).toBe(201);
      expect(existsSync(join(worktreePath!, 'work.txt'))).toBe(true);
      expect(store.getRun(id)).toMatchObject({ branch, worktreeReclaimedAt: undefined, pullRequestUrl: expect.any(String) });
    });

    it('409s while a run is being Continued, and leaves its directory alone', async () => {
      const id = await resumable();
      expect(manager.continueRun(id, { text: 'go on' }).ok).toBe(true);
      expect((await reclaimOne(id)).status).toBe(409);
      expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(true);
    });
  });

  it('human deletion still cleans an ordinary terminal run', async () => {
    const id = await seed(randomUUID(), 'done'); const path = store.getRun(id)!.worktreePath!;
    expect((await apiRequest(app, `/api/v1/runs/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(store.getRun(id)).toBeUndefined(); expect(existsSync(path)).toBe(false);
  });

});
