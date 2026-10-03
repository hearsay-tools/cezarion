import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoBranchesResponse, RepoResponse } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import type { BranchForge } from './repo-branches.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const git = async (cwd: string, ...args: string[]) => (await exec('git', [...GIT_ID, ...args], { cwd })).stdout.trim();

/**
 * The Git view's branch routes (issue 08 §B): `GET /repo` `tracking` + log `source`,
 * `GET /repo/branches`, `POST /repo/branches/delete`. The classifier's own matrix lives in
 * `repo-branches.test.ts`; this file pins the wire — statuses, shapes, the cache — against a real
 * temp repository and an injected forge.
 */
describe('the repo branches API', () => {
  let repoRoot: string;
  let cezHome: string;
  let store: RunStore;
  let app: Hono;
  let manager: RunManager;
  let forgeCalls: number;
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  const forge: BranchForge = {
    async prStates() {
      forgeCalls++;
      return { available: true, states: {} };
    },
    async listPrs() {
      forgeCalls++;
      return { available: true, prs: [] };
    },
  };

  beforeEach(async () => {
    cezHome = mkdtempSync(join(tmpdir(), 'cez-branchapi-home-'));
    process.env.CEZ_HOME = cezHome;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-branchapi-'));
    await git(repoRoot, 'init', '-q', '-b', 'main');
    await git(repoRoot, 'config', 'gc.auto', '0');
    await git(repoRoot, 'config', 'maintenance.auto', 'false');
    writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    await git(repoRoot, 'add', '-A');
    await git(repoRoot, 'commit', '-q', '-m', 'base');
    // A remote exists (so the forge is consulted) but is never contacted.
    await git(repoRoot, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    forgeCalls = 0;
    // A real manager: a delete claims the owning runs through it, the claim Continue is refused by.
    manager = new RunManager(store, repoRoot);
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      branchForge: forge,
    });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(cezHome, { recursive: true, force: true });
  });

  /** A finished task with `commits` commits on its own branch. */
  async function finishedTask(commits: number): Promise<{ id: string; branch: string }> {
    const rec = store.createRun({ title: `task ${commits}`, workflow: 'w', task: 't', steps: [] });
    const branch = `cez/${rec.id.slice(0, 8)}`;
    await git(repoRoot, 'checkout', '-q', '-b', branch, 'main');
    for (let i = 0; i < commits; i++) {
      writeFileSync(join(repoRoot, `${rec.id}-${i}.txt`), `${i}\n`);
      await git(repoRoot, 'add', '-A');
      await git(repoRoot, 'commit', '-q', '-m', `work ${i}`);
    }
    await git(repoRoot, 'checkout', '-q', 'main');
    store.updateRun(rec.id, { status: 'done', branch, baseBranch: 'main' });
    return { id: rec.id, branch };
  }

  const branches = async () => {
    const res = await apiRequest(app, '/api/v1/repo/branches');
    expect(res.status).toBe(200);
    return (await res.json()) as RepoBranchesResponse;
  };
  const del = (body: unknown) =>
    apiRequest(app, '/api/v1/repo/branches/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET /repo carries tracking (null without an upstream) and attributes a squash commit to its task', async () => {
    const rec = store.createRun({ title: 'the squashed one', workflow: 'w', task: 't', steps: [] });
    store.updateRun(rec.id, { status: 'done', pullRequestUrl: 'https://github.com/acme/demo/pull/42' });
    writeFileSync(join(repoRoot, 'squash.txt'), 'x\n');
    await git(repoRoot, 'add', '-A');
    await git(repoRoot, 'commit', '-q', '-m', 'feat: squashed (#42)');
    const res = await apiRequest(app, '/api/v1/repo');
    const body = (await res.json()) as Extract<RepoResponse, { info: object }>;
    expect(body.tracking).toBeNull();
    expect(body.log[0]).toMatchObject({ subject: 'feat: squashed (#42)', source: { runId: rec.id, title: 'the squashed one', prNumber: 42 } });
    // Unattributed rows carry no `source` key at all — never `null`, never parents.
    expect(body.log[1]).toEqual({ hash: expect.any(String), subject: 'base', author: expect.any(String), when: expect.any(String), at: expect.any(String) });
  });

  it('GET /repo log rows carry the absolute committer date the cockpit groups by day', async () => {
    writeFileSync(join(repoRoot, 'dated.txt'), 'x\n');
    await git(repoRoot, 'add', '-A');
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'dated'], {
      cwd: repoRoot,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-09-29T23:50:00+02:00', GIT_AUTHOR_DATE: '2026-09-29T23:50:00+02:00' },
    });
    const body = (await (await apiRequest(app, '/api/v1/repo')).json()) as Extract<RepoResponse, { info: object }>;
    expect(body.log[0]).toMatchObject({ subject: 'dated', at: '2026-09-29T23:50:00+02:00' });
    expect(Date.parse(body.log[0]!.at)).toBe(Date.parse('2026-09-29T21:50:00Z'));
  });

  it('GET /repo/branches classifies, counts, and serves the cached answer while nothing changed', async () => {
    const notLanded = await finishedTask(2);
    const empty = await finishedTask(0);
    const body = await branches();
    expect(body.base).toBe('main');
    expect(body.prStateKnown).toBe(true);
    expect(body.counts).toEqual({ notLanded: 1, cleanup: 1 });
    const byName = Object.fromEntries(body.branches.map((b) => [b.name, b]));
    expect(byName[notLanded.branch]).toMatchObject({ class: 'not-landed', runId: notLanded.id, ahead: 2, diffStat: { additions: 2, deletions: 0 } });
    expect(byName[empty.branch]).toMatchObject({ class: 'empty', diffStat: null });
    expect(byName.main?.class).toBe('active');

    const calls = forgeCalls;
    await branches();
    expect(forgeCalls).toBe(calls); // cached: nothing moved
    await git(repoRoot, 'branch', 'mine');
    expect((await branches()).branches.map((b) => b.name)).toContain('mine'); // refs moved: recomputed
  });

  it('holds Continue off while a confirmed delete removes its task\'s branch', async () => {
    process.env.CEZ_DRY_RUN = '1';
    const { id, branch } = await finishedTask(1);
    store.updateRun(id, { steps: [{ id: 'task', name: 'Task', kind: 'agent', status: 'done', sessionId: 'sess-1', backend: 'claude' }] } as never);
    const claimed = new Promise<void>((resolve) => {
      const claim = manager.claimForBranchCleanup.bind(manager);
      vi.spyOn(manager, 'claimForBranchCleanup').mockImplementation((ids) => {
        const release = claim(ids);
        resolve();
        return release;
      });
    });
    const pending = del({ names: [branch], confirm: branch });
    await claimed;
    expect(manager.continueRun(id, { text: 'go on' })).toEqual({ ok: false, error: expect.stringContaining('being cleaned up') });
    expect((await pending).status).toBe(200);
  });

  it('a branch switch cannot land on a branch while its delete is running', async () => {
    const { branch } = await finishedTask(1);
    const inFlight = new Promise<void>((resolve) => {
      const claim = manager.claimForBranchCleanup.bind(manager);
      vi.spyOn(manager, 'claimForBranchCleanup').mockImplementation((ids) => {
        resolve();
        return claim(ids);
      });
    });
    const pending = del({ names: [branch], confirm: branch });
    await inFlight;
    const switched = await apiRequest(app, '/api/v1/repo/branch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: branch }),
    });
    expect(switched.status).toBe(409);
    expect((await pending).status).toBe(200);
    expect(await git(repoRoot, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('refuses to delete a branch whose task another cleanup has claimed', async () => {
    const { id, branch } = await finishedTask(1);
    // The classification sees an idle, finished task; only the claim knows it is taken.
    const hold = manager.claimForBranchCleanup([id])!;
    const res = await del({ names: [branch], confirm: branch });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('running or being continued');
    expect(await git(repoRoot, 'rev-parse', '--verify', branch)).toMatch(/^[0-9a-f]{40}$/);
    hold();
    expect((await del({ names: [branch], confirm: branch })).status).toBe(200);
  });

  it('POST /repo/branches/delete bulk-deletes the safe rows and refuses the rest with 200', async () => {
    const notLanded = await finishedTask(1);
    const empty = await finishedTask(0);
    const res = await del({ names: [notLanded.branch, empty.branch] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string[]; refused: Array<{ name: string }> };
    expect(body.deleted).toEqual([empty.branch]);
    expect(body.refused.map((r) => r.name)).toEqual([notLanded.branch]);
    expect(await git(repoRoot, 'branch', '--list', notLanded.branch)).not.toBe('');
    const after = await branches();
    expect(after.branches.map((b) => b.name)).not.toContain(empty.branch); // the cache was dropped
  });

  it('409s when nothing can be deleted: active, other, or an unconfirmed not-landed branch', async () => {
    const notLanded = await finishedTask(1);
    await git(repoRoot, 'branch', 'mine');
    for (const body of [{ names: ['main'] }, { names: ['mine'], confirm: 'mine' }, { names: [notLanded.branch] }, { names: [notLanded.branch], confirm: 'nope' }]) {
      const res = await del(body);
      expect(res.status).toBe(409);
      const answer = (await res.json()) as { error: string; refused: unknown[] };
      expect(answer.error).toEqual(expect.any(String));
      expect(answer.refused).toHaveLength(1);
    }
    const confirmed = await del({ names: [notLanded.branch], confirm: notLanded.branch });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ deleted: [notLanded.branch], dropped: [{ subject: 'work 0' }] });
  });

  it('400s a body with no names', async () => {
    expect((await del({ names: [] })).status).toBe(400);
    expect((await del({})).status).toBe(400);
  });

  it('works under CEZ_DRY_RUN=1 with the default forge — no gh, PR state still known', async () => {
    process.env.CEZ_DRY_RUN = '1';
    app = createApp({ repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' });
    const task = await finishedTask(1);
    const body = await branches();
    expect(body.prStateKnown).toBe(true);
    expect(body.branches.find((b) => b.name === task.branch)?.class).toBe('not-landed');
  });

  it('answers an empty list outside a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-branchapi-plain-'));
    try {
      mkdirSync(join(plain, '.ai/cezar'), { recursive: true });
      const plainStore = RunStore.open(join(plain, '.ai/cezar'));
      app = createApp({ repoRoot: plain, store: plainStore, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' });
      expect(await branches()).toEqual({ base: '', prStateKnown: false, branches: [], counts: { notLanded: 0, cleanup: 0 } });
      plainStore.flush();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
