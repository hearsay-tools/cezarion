import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('project checkout pull', () => {
  let dir: string;
  let root: string;
  let remote: string;
  let source: string;
  let app: Hono;
  let store: RunStore;
  let remoteHead: string;
  let initialHead: string;
  const active = new Set<string>();

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    dir = mkdtempSync(join(tmpdir(), 'cez-pull-'));
    root = join(dir, 'checkout');
    remote = join(dir, 'remote.git');
    source = join(dir, 'source');
    git(dir, 'init', '--bare', '--initial-branch=main', remote);
    git(dir, 'clone', remote, source);
    git(source, 'config', 'user.name', 'Test');
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(source, '.gitignore'), '.ai/\n');
    writeFileSync(join(source, 'base.txt'), 'base\n');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'base');
    git(source, 'push', '-u', 'origin', 'main');
    git(dir, 'clone', remote, root);
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'commit.gpgsign', 'false');
    // Pin fixture policy across Git versions; the rebase-specific test overrides this.
    git(root, 'config', 'pull.rebase', 'false');
    initialHead = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'remote.txt'), 'remote change\n');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'remote change');
    git(source, 'push');
    remoteHead = git(source, 'rev-parse', 'HEAD');
    active.clear();
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    app = createApp({ repoRoot: root, store,
      manager: { isActive: (id: string) => active.has(id) } as RunManager,
      version: 'test' });
  });
  afterEach(() => {
    store?.flush();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const post = (body: unknown = {}, path = '/api/v1/repo/pull') => apiRequest(app, path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  function baseBranch(branch: string) {
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ baseBranch: branch }));
  }

  it('pulls the checked-out branch with no extra confirmation when clean and idle', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ branch: 'main', pulled: true, summary: expect.any(String) });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(readFileSync(join(root, 'remote.txt'), 'utf8')).toBe('remote change\n');
  });
  it('defaults to the configured base and leaves it checked out', async () => {
    git(root, 'checkout', '-b', 'feature');
    baseBranch('main');
    expect((await post()).status).toBe(200);
    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect(git(root, 'rev-parse', 'main')).toBe(remoteHead);
    expect(git(root, 'rev-parse', 'feature')).toBe(initialHead);
  });
  it('honors a chosen local branch and its configured upstream', async () => {
    git(root, 'branch', '--track', 'release', 'origin/main');
    baseBranch('main');
    const res = await post({ branch: 'release' });
    expect(res.status).toBe(200);
    expect(git(root, 'branch', '--show-current')).toBe('release');
    expect(git(root, 'rev-parse', 'release')).toBe(remoteHead);
    expect(git(root, 'rev-parse', 'main')).toBe(initialHead);
  });
  it.each(['queued', 'running', 'waiting', 'review'] as const)('asks before mutation for an active %s session', async (status) => {
    const run = store.createRun({ title: 'active', task: 'active', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status });
    active.add(run.id);
    git(root, 'checkout', '-b', 'feature');
    const res = await post({ branch: 'main' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ branch: 'main', risks: ['active_runs'] });
    expect(git(root, 'branch', '--show-current')).toBe('feature');
    expect(git(root, 'rev-parse', 'main')).toBe(initialHead);
    expect((await post({ branch: 'main', confirm: true })).status).toBe(200);
    expect(git(root, 'rev-parse', 'main')).toBe(remoteHead);
  });
  it('does not gate a settled review session', async () => {
    const run = store.createRun({ title: 'review', task: 'review', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'review' });
    expect((await post()).status).toBe(200);
  });
  it.each(['modified', 'untracked', 'staged'])('asks before pulling with %s files, and keeps unrelated edits on confirmation', async (kind) => {
    const path = kind === 'untracked' ? 'notes.txt' : 'base.txt';
    writeFileSync(join(root, path), 'my work\n');
    if (kind === 'staged') git(root, 'add', path);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ branch: 'main', risks: ['dirty_tree'] });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(initialHead);
    expect((await post({ confirm: true })).status).toBe(200);
    expect(readFileSync(join(root, path), 'utf8')).toBe('my work\n');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(remoteHead);
  });
  it('detects untracked files even when Git status is configured to hide them', async () => {
    git(root, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(root, 'notes.txt'), 'my work\n');
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ risks: ['dirty_tree'] });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(initialHead);
  });
  it('detects dirty submodules even when their changes are configured to be hidden', async () => {
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', remote, 'sub');
    git(root, 'commit', '-am', 'add submodule');
    git(root, 'config', 'submodule.sub.ignore', 'all');
    writeFileSync(join(root, 'sub/base.txt'), 'submodule work\n');
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ risks: ['dirty_tree'] });
    expect(readFileSync(join(root, 'sub/base.txt'), 'utf8')).toBe('submodule work\n');
  });
  it('keeps a successfully switched branch checked out when its pull fails', async () => {
    git(root, 'branch', '--track', 'feature', 'origin/main');
    git(root, 'remote', 'set-url', 'origin', join(dir, 'missing-remote'));
    const res = await post({ branch: 'feature' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
    expect(git(root, 'branch', '--show-current')).toBe('feature');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(initialHead);
  });
  it.each(['', 'a'.repeat(201)])('rejects empty or oversized branch names at the boundary', async (branch) => {
    expect((await post({ branch })).status).toBe(400);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(initialHead);
  });
  it('never auto-stashes confirmed edits even when pull.autoStash overrides rebase config', async () => {
    // pull.autoStash takes precedence on newer Git. Rebase requires a clean index when
    // auto-stash is disabled, so this must refuse and preserve both HEAD and the edit.
    git(root, 'config', 'pull.rebase', 'true');
    git(root, 'config', 'pull.autoStash', 'true');
    git(root, 'config', 'rebase.autoStash', 'true');
    writeFileSync(join(root, 'base.txt'), 'my work\n');
    const res = await post({ confirm: true });
    expect(res.status).toBe(409);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(initialHead);
    expect(readFileSync(join(root, 'base.txt'), 'utf8')).toBe('my work\n');
    expect(git(root, 'stash', 'list')).toBe('');
  });
  it('reports both risks together before switching a dirty checkout', async () => {
    git(root, 'checkout', '-b', 'feature');
    writeFileSync(join(root, 'base.txt'), 'my work\n');
    const run = store.createRun({ title: 'active', task: 'active', workflow: 'quick-task', steps: [] });
    active.add(run.id);
    const res = await post({ branch: 'main' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ branch: 'main', risks: ['active_runs', 'dirty_tree'] });
    expect(git(root, 'branch', '--show-current')).toBe('feature');
  });
  it('confirmation never overrides Git protection of overlapping edits', async () => {
    writeFileSync(join(root, 'remote.txt'), 'my untracked file\n');
    const res = await post({ confirm: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/overwritten|untracked/i) });
    expect(readFileSync(join(root, 'remote.txt'), 'utf8')).toBe('my untracked file\n');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(initialHead);
  });
  it.each(['--upload-pack=bad', '-x', 'main\nother', '@{-1}', 'missing', 'origin/main'])('rejects invalid or nonlocal branch %j without mutation', async (branch) => {
    const res = await post({ branch, confirm: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toHaveProperty('error');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(initialHead);
  });
  it('returns a clear no-remote error before switching', async () => {
    git(root, 'remote', 'remove', 'origin');
    git(root, 'checkout', '-b', 'feature');
    const res = await post({ branch: 'main' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/no remote/i) });
    expect(git(root, 'branch', '--show-current')).toBe('feature');
  });
  it('returns a clear missing-upstream error before switching', async () => {
    git(root, 'branch', 'feature');
    const res = await post({ branch: 'feature' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/upstream|tracking/i) });
    expect(git(root, 'branch', '--show-current')).toBe('main');
  });
  it('serves the scoped alias', async () => {
    expect((await post({}, '/api/v1/p/default/repo/pull')).status).toBe(200);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(remoteHead);
  });
  it('validates the request at the boundary', async () => {
    expect((await post({ branch: 123 })).status).toBe(400);
    expect((await post({ confirm: 'yes' })).status).toBe(400);
  });
  it('lists only local branches, preserving remote-only and task branches in existing repo data', async () => {
    git(root, 'branch', 'local');
    git(root, 'update-ref', 'refs/remotes/origin/remote-only', initialHead);
    const res = await apiRequest(app, '/api/v1/repo/pull');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ branches: ['local', 'main'] });
    const repo = await apiRequest(app, '/api/v1/repo');
    expect(await repo.json()).toMatchObject({ branches: expect.arrayContaining(['remote-only']) });
  });
  it('rejects another pull and branch switch while a pull is in progress', async () => {
    const started = join(dir, 'hook-started');
    const release = join(dir, 'hook-release');
    const hook = join(root, '.git/hooks/post-merge');
    writeFileSync(hook, `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.02; done\n`);
    chmodSync(hook, 0o755);
    const pending = post();
    try {
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: HANG_GUARD_MS });
      const other = await post();
      expect(other.status).toBe(409);
      expect(await other.json()).toMatchObject({ error: expect.stringMatching(/in progress/i) });
      const branch = await apiRequest(app, '/api/v1/repo/branch', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'other' }) });
      expect(branch.status).toBe(409);
      expect(await branch.json()).toMatchObject({ error: expect.stringMatching(/in progress/i) });
    } finally {
      writeFileSync(release, 'release');
      await pending;
    }
    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect((await post()).status).toBe(200);
  });
  it('rejects a pull while a cockpit branch switch is in progress', async () => {
    git(root, 'branch', '--track', 'feature', 'origin/main');
    const started = join(dir, 'hook-started');
    const release = join(dir, 'hook-release');
    const hook = join(root, '.git/hooks/post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.02; done\n`);
    chmodSync(hook, 0o755);
    const pending = apiRequest(app, '/api/v1/repo/branch', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'feature' }) });
    try {
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: HANG_GUARD_MS });
      const other = await post();
      expect(other.status).toBe(409);
      expect(await other.json()).toMatchObject({ error: expect.stringMatching(/in progress/i) });
    } finally {
      writeFileSync(release, 'release');
      await pending;
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(initialHead);
  });
  it('dry-run reports success without changing the checkout or contacting its remote', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    git(root, 'branch', '--track', 'feature', 'origin/main');
    git(root, 'remote', 'set-url', 'origin', join(dir, 'unreachable'));
    const res = await post({ branch: 'feature' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pulled: true, branch: 'feature', summary: expect.stringMatching(/dry.run/i) });
    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(initialHead);
  });
});
