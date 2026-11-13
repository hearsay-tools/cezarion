import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { join, resolve } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';


import { gitCommonDir } from './workspace-git.ts';
import { WORKTREE_LOCK_BUSY_ERROR } from './workspace-removal.ts';

import { withWorktreeMutation } from '../git-worktree-lock.ts';

import { f, linux, cadence, settled, destroyOf, useDestroyBackoffFixture } from './service-destroy-backoff.testkit.ts';

describe('destroy backoff topology-repair', { timeout: 30_000 }, () => {
  useDestroyBackoffFixture();

  it.runIf(linux)('lock contention is retried in full once it clears, never skipped as unchanged', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await settled(false);
    let unlock!: () => void, locked!: () => void;
    const held = new Promise<void>(done => { unlock = done; }), ready = new Promise<void>(done => { locked = done; });
    const keeper = withWorktreeMutation(f.root, async () => { locked(); await held; });
    await ready;
    try {
      expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', error: WORKTREE_LOCK_BUSY_ERROR });
      // Past the fixture's one real change, and still contended.
      await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
      expect(destroyOf(workerId)).toMatchObject({ phase: 'incomplete', error: WORKTREE_LOCK_BUSY_ERROR });
    } finally { unlock(); await keeper; }
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
    expect(existsSync(workspace.path)).toBe(false);
  });

  it.runIf(linux)('an in-place repair of the ownership marker ends the skipping', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await settled(false);
    const admin = resolve(workspace.path, /^gitdir: (.+)$/m.exec(readFileSync(join(workspace.path, '.git'), 'utf8'))![1]!.trim());
    const marker = join(admin, 'cezar-owned-resource'), original = readFileSync(marker, 'utf8');
    writeFileSync(marker, randomUUID());
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete' });
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(destroyOf(workerId)?.phase).toBe('incomplete');
    writeFileSync(marker, original);
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
    expect(existsSync(workspace.path)).toBe(false);
  });

  it.runIf(linux)('a worktree whose HEAD points at another branch is retried in full once restored, never skipped', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await settled(false);
    // In place, as an editor or a script would: the admin directory's own stamp does not move.
    const admin = resolve(workspace.path, /^gitdir: (.+)$/m.exec(readFileSync(join(workspace.path, '.git'), 'utf8'))![1]!.trim());
    const head = join(admin, 'HEAD'), attached = readFileSync(head, 'utf8');
    // Another branch, not a detached HEAD: `symbolic-ref` answers, so this is a refusal, not a throw.
    writeFileSync(head, 'ref: refs/heads/elsewhere\n');
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(destroyOf(workerId)?.phase).toBe('incomplete');
    writeFileSync(head, attached);
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
    expect(existsSync(workspace.path)).toBe(false);
  });

  it.runIf(linux)('a receipt-gone destroy that a stray admin marker refuses is retried in full once the marker is repaired', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await settled(false);
    const common = await gitCommonDir(f.root);
    // hearsay-tools/cezarion#878's shape: worktree, branch and receipt gone, but a leftover admin directory still names this resource.
    execFileSync('git', ['worktree', 'remove', workspace.path], { cwd: f.root });
    execFileSync('git', ['branch', '-D', workspace.branch], { cwd: f.root });
    rmSync(join(common, 'cezar-owned-workspaces', `${workspace.resourceId}.json`));
    const stray = join(common, 'worktrees', 'stray');
    mkdirSync(stray, { recursive: true, mode: 0o700 });
    writeFileSync(join(stray, 'cezar-owned-resource'), workspace.resourceId, { mode: 0o600 });
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete' });
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(destroyOf(workerId)?.phase).toBe('incomplete');
    // Repaired in place: the `worktrees` directory itself does not change.
    writeFileSync(join(stray, 'cezar-owned-resource'), randomUUID());
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
  });

  it.runIf(linux)('a failed Git step with no holder to name is retried in full once it clears, never skipped', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await settled(false);
    // A stale ref lock: the branch delete fails after every check passed, and nothing the key reads changes when it goes.
    const lock = join(await gitCommonDir(f.root), 'refs/heads', `${workspace.branch}.lock`);
    writeFileSync(lock, '');
    onTestFinished(() => rmSync(lock, { force: true }));
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['branch'] });
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(destroyOf(workerId)).toMatchObject({ phase: 'incomplete', remaining: ['branch'] });
    rmSync(lock);
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
  });
});
