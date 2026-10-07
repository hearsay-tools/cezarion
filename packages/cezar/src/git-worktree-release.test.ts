import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
/** Whether the fake removal declines (a dirty tree under `onlyClean`, a protected path). */
let declines = false;

vi.mock('./delegation/workspace.ts', () => ({
  removeOwnedWorkspace: vi.fn(async (repoRoot: string, value: { ownerRunId: string; path: string }, _assert?: unknown, beforeRemove?: () => Promise<void>) => {
    if (declines) return { workerId: value.ownerRunId, state: 'incomplete', remaining: ['worktree', 'branch'] };
    await beforeRemove?.();
    order.push(`remove owned ${JSON.stringify([repoRoot, value.path])}`);
    return { workerId: value.ownerRunId, state: 'complete', remaining: [] };
  }),
}));

vi.mock('./git-worktree.ts', () => ({
  removeWorktree: vi.fn(async (repoRoot: string, path: string, branch?: string, opts?: { onlyClean?: boolean; beforeRemove?: () => Promise<void> }) => {
    if (declines) return;
    await opts?.beforeRemove?.();
    order.push(`remove ${JSON.stringify([repoRoot, path, branch ?? null, opts?.onlyClean ?? null])}`);
  }),
}));

const { releaseThenRemoveOwnedWorkspace, releaseThenRemoveWorktree } = await import('./git-worktree-release.ts');

/**
 * Worktree removal releases the task's preview (#781, spec 2026-10-02-live-preview-v1 "Exit
 * triggers"): a dev server must not keep running from a directory that is gone, so every removal
 * goes through one helper, and a scan keeps it that way. The release waits for the removal to go
 * ahead: a declined removal keeps the directory, so it keeps the preview too.
 */
describe('releaseThenRemoveWorktree', () => {
  beforeEach(() => {
    order.length = 0;
    declines = false;
  });

  it('releases the preview before removing the worktree', async () => {
    const previewHost = { release: vi.fn(async (runId: string) => { order.push(`release ${runId}`); }) };
    await releaseThenRemoveWorktree({ previewHost }, 'run-1', '/repo', '/repo/.ai/cezar/worktrees/run-1', 'cez/run-1', { onlyClean: true });
    expect(order).toEqual(['release run-1', `remove ${JSON.stringify(['/repo', '/repo/.ai/cezar/worktrees/run-1', 'cez/run-1', true])}`]);
  });

  it('releases nothing when the removal declines', async () => {
    declines = true;
    const previewHost = { release: vi.fn(async () => undefined) };
    await releaseThenRemoveWorktree({ previewHost }, 'run-1', '/repo', '/wt', undefined, { onlyClean: true });
    expect(previewHost.release).not.toHaveBeenCalled();
  });

  it('still removes the worktree when no preview host runs or its release fails', async () => {
    await releaseThenRemoveWorktree({}, 'run-1', '/repo', '/wt');
    await releaseThenRemoveWorktree({ previewHost: { release: async () => { throw new Error('boom'); } } }, 'run-2', '/repo', '/wt2');
    expect(order).toEqual([`remove ${JSON.stringify(['/repo', '/wt', null, null])}`, `remove ${JSON.stringify(['/repo', '/wt2', null, null])}`]);
  });
});

describe('releaseThenRemoveOwnedWorkspace (#781 final review: a destroyed worker)', () => {
  beforeEach(() => {
    order.length = 0;
    declines = false;
  });
  const workspace = { ownerRunId: 'worker-1', path: '/repo/.ai/cezar/worktrees/worker-1' } as Parameters<typeof releaseThenRemoveOwnedWorkspace>[2];

  it("releases the worker's preview before git removes its checkout", async () => {
    const previewHost = { release: vi.fn(async (runId: string) => { order.push(`release ${runId}`); }) };
    expect(await releaseThenRemoveOwnedWorkspace({ previewHost }, '/repo', workspace)).toMatchObject({ state: 'complete' });
    expect(order).toEqual(['release worker-1', `remove owned ${JSON.stringify(['/repo', workspace.path])}`]);
  });

  it('releases nothing when the cleanup declines, and a failed release never blocks the removal', async () => {
    declines = true;
    const previewHost = { release: vi.fn(async () => undefined) };
    await releaseThenRemoveOwnedWorkspace({ previewHost }, '/repo', workspace);
    expect(previewHost.release).not.toHaveBeenCalled();
    declines = false;
    await releaseThenRemoveOwnedWorkspace({ previewHost: { release: async () => { throw new Error('boom'); } } }, '/repo', workspace);
    expect(order).toEqual([`remove owned ${JSON.stringify(['/repo', workspace.path])}`]);
  });
});

describe('removeWorktree call sites', () => {
  const SRC = import.meta.dirname;
  const ALLOWED = new Set(['git-worktree.ts', 'git-worktree-release.ts']);
  /** Where git removes a worktree itself: the two removals the helpers wrap. */
  const RAW_REMOVAL = new Set(['git-worktree.ts', join('delegation', 'workspace.ts')]);

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : sources(path);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
    });
  }

  it('no source outside the helper calls removeWorktree directly', () => {
    const offenders = sources(SRC)
      .filter(path => !ALLOWED.has(relative(SRC, path)))
      .filter(path => /\bremoveWorktree\(/.test(readFileSync(path, 'utf8')))
      .map(path => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it('no source outside the helper calls removeOwnedWorkspace directly', () => {
    const offenders = sources(SRC)
      .filter(path => !ALLOWED.has(relative(SRC, path)) && !RAW_REMOVAL.has(relative(SRC, path)))
      .filter(path => /\bremoveOwnedWorkspace\(/.test(readFileSync(path, 'utf8')))
      .map(path => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it("no source outside the two wrapped removals runs git's worktree remove", () => {
    const offenders = sources(SRC)
      .filter(path => !RAW_REMOVAL.has(relative(SRC, path)))
      .filter(path => /\[\s*'worktree'\s*,\s*'remove'/.test(readFileSync(path, 'utf8')))
      .map(path => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});
