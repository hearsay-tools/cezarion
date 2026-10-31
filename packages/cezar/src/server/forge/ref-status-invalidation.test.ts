import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../../runs/store.ts';
import type { RunManager } from '../../workflows/run.ts';
import { apiRequest } from '../loopback-request.testkit.ts';
import { __seedRefStatusCacheForTests, readCachedRefStatuses, createGithubDriver, fetchGithubItem } from './github.ts';
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => args[0] === 'gh'
    ? execFileMock(...args)
    : (actual.execFile as (...args: unknown[]) => unknown)(...args.slice(0, -1),
      (error: Error | null, stdout: string, stderr: string) =>
        (args.at(-1) as (error: Error | null, result: { stdout: string; stderr: string }) => void)(error, { stdout, stderr })) };
});

import { createApp } from '../server.ts';

/**
 * The two places cezar changes a pull request itself — and therefore the two places it must stop
 * trusting what it cached about one.
 *
 * Everything else about a reference has to be polled: GitHub cannot push to a cockpit with no
 * public endpoint. But waiting out a TTL to notice OUR OWN merge is self-inflicted staleness — for
 * up to a minute every chip would keep showing the pre-merge status of a pull request the user
 * just watched this server merge. These tests pin the wiring; `forge/github.test.ts` pins what
 * `forgetRefStatus` and `refNumberFromUrl` actually do.
 *
 * Mutations use `CEZ_DRY_RUN=1`; item-cache reads use a mocked subprocess. Assertions pin
 * the cache effect after success and retention after refusal, through the real driver.
 */

describe('a reference cezar changes itself is forgotten, not waited out', () => {
  let repoRoot: string;
  const seed = (...numbers: number[]) => __seedRefStatusCacheForTests(repoRoot, numbers.map(number => [number, { kind: 'pr', status: 'ready' }]));
  const primeItem = async () => {
    process.env.CEZ_DRY_RUN = '0';
    execFileMock.mockClear();
    expect(await fetchGithubItem(repoRoot, 'pr', 128)).toEqual({ available: true, item: null });
    process.env.CEZ_DRY_RUN = '1';
    execFileMock.mockClear();
  };
  const expectItemRead = async (refetched: boolean) => {
    process.env.CEZ_DRY_RUN = '0';
    await fetchGithubItem(repoRoot, 'pr', 128);
    expect(execFileMock.mock.calls.length > 0).toBe(refetched);
    process.env.CEZ_DRY_RUN = '1';
  };
  let store: RunStore;
  let app: Hono;
  const previousDryRun = process.env.CEZ_DRY_RUN;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });
  afterAll(() => {
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
  });

  beforeEach(() => {

    execFileMock.mockImplementation((_bin, args, _opts, callback) => {
      callback(args[0] === 'repo' ? null : new Error('no pull requests found'), { stdout: '{}', stderr: '' });
    });
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-refinvalidate-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false, claimForPublish: () => () => undefined } as unknown as RunManager,
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('forgets the pull request it merged', async () => {
    seed(128, 129);
    await primeItem();
    const state = await apiRequest(app, '/api/v1/github/prs/128/merge-state?refresh=1');
    const stateBody = await state.json();
    expect(stateBody, JSON.stringify(stateBody)).toMatchObject({ available: true });
    const { mergeState } = stateBody as { mergeState: { headSha: string } };

    const merged = await apiRequest(app, '/api/v1/github/prs/128/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'squash', expectedHeadSha: mergeState.headSha }),
    });

    expect(merged.status).toBe(200);
    expect(readCachedRefStatuses(repoRoot, [128, 129])).toEqual({ prs: { 129: 'ready' }, issues: {} });
    await expectItemRead(true);
  });

  it('leaves the cache alone when the merge was REFUSED', async () => {
    seed(128, 129);
    await primeItem();
    // Nothing changed on the forge, so nothing we hold about it became wrong. Forgetting anyway
    // would spend a query to be told the same thing.
    const refused = await apiRequest(app, '/api/v1/github/prs/128/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'squash', expectedHeadSha: 'f'.repeat(40) }),
    });

    expect(refused.status).not.toBe(200);
    expect(readCachedRefStatuses(repoRoot, [128, 129])).toEqual({ prs: { 128: 'ready', 129: 'ready' }, issues: {} });
    await expectItemRead(false);
  });

  it('forgets the pull request it opened', async () => {
    seed(777, 129);
    // A number asked about BEFORE the pull request existed is cached as "this repository has no
    // such number" — exactly what a `CEZ:PR=N` marker declared ahead of the push looks like.
    const worktree = mkdtempSync(join(tmpdir(), 'cez-refinvalidate-wt-'));
    execFileSync('git', ['init', '-b', 'cez/abc'], { cwd: worktree });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktree });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'work'], { cwd: worktree });
    const run = store.createRun({ title: 'Ship it', task: 'ship it', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'review', worktreePath: worktree, branch: 'cez/abc' });

    const created = await apiRequest(app, `/api/v1/runs/${run.id}/pr`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321' },
    });

    try {
      expect(created.status).toBe(201);
      // The dry-run catalog's fake PR URL is `…/pull/777`.
      expect(readCachedRefStatuses(repoRoot, [777, 129])).toEqual({ prs: { 129: 'ready' }, issues: {} });
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
  it('forgets only the pull requests passed after a branch push', () => {
    seed(128, 129, 130);
    createGithubDriver(repoRoot, null).branchPushed([128, 130]);
    expect(readCachedRefStatuses(repoRoot, [128, 129, 130])).toEqual({ prs: { 129: 'ready' }, issues: {} });
  });

});
