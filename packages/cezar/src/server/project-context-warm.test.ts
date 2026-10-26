import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunManager } from '../workflows/run.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import type { CockpitOwnership } from './cockpit-ownership.ts';
import { ProjectContexts, ProjectContextsClosedError, type ProjectWarmCandidate } from './project-context.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

/**
 * Background warm-up (#667): after the server listens, every registered project's context is
 * built one at a time, most recently opened first, so the first click on a project finds it
 * ready instead of paying the store open, the worktree sweeps and `recover()` on that click.
 */
describe('ProjectContexts.warmAll', () => {
  const roots: string[] = [];
  const children: ChildProcess[] = [];
  let warn: ReturnType<typeof vi.spyOn>;

  const root = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-warm-'));
    roots.push(dir);
    return dir;
  };

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeContexts(projects: ProjectWarmCandidate[]): { contexts: ProjectContexts; built: string[] } {
    const contexts = new ProjectContexts({ listProjects: async () => projects });
    const built: string[] = [];
    contexts.onContextBuilt((ctx) => built.push(ctx.id));
    return { contexts, built };
  }

  it('builds every project once, most recently opened first, and skips missing and built ones', async () => {
    const projects: ProjectWarmCandidate[] = [
      { id: 'old', root: root(), status: 'not-git', lastOpenedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'gone', root: join(tmpdir(), 'cez-warm-missing'), status: 'missing', lastOpenedAt: '2026-10-11T00:00:00.000Z' },
      { id: 'new', root: root(), status: 'not-git', lastOpenedAt: '2026-10-10T00:00:00.000Z' },
      { id: 'never', root: root(), status: 'not-git' },
      { id: 'open', root: root(), status: 'not-git', lastOpenedAt: '2026-10-12T00:00:00.000Z' },
    ];
    const { contexts, built } = makeContexts(projects);
    try {
      await contexts.context('open');
      built.length = 0;

      const warmed = await contexts.warmAll(projects);

      expect(warmed).toEqual(['new', 'old', 'never']);
      expect(built).toEqual(['new', 'old', 'never']);
      expect(contexts.ids().sort()).toEqual(['never', 'new', 'old', 'open']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      contexts.disposeAll();
    }
  });

  it('leaves a project another live cockpit owns alone', async () => {
    const owned = root();
    const dataDir = join(owned, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    children.push(other);
    const startToken = processStartToken(other.pid!);
    writeFileSync(join(dataDir, 'cockpit.lock'), JSON.stringify({
      pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}), url: 'http://127.0.0.1:1/',
    }));
    const { contexts, built } = makeContexts([{ id: 'owned', root: owned, status: 'not-git' }]);
    try {
      expect(await contexts.warmAll([{ id: 'owned', root: owned, status: 'not-git' }])).toEqual([]);
      expect(built).toEqual([]);
    } finally {
      contexts.disposeAll();
    }
  });

  it('logs a failed build once, keeps going, and caches nothing so the next click retries', async () => {
    const broken = root();
    // A data dir that is a file: the store cannot open.
    mkdirSync(join(broken, '.ai'), { recursive: true });
    writeFileSync(join(broken, '.ai/cezar'), 'not a directory');
    const projects: ProjectWarmCandidate[] = [
      { id: 'broken', root: broken, status: 'not-git', lastOpenedAt: '2026-10-12T00:00:00.000Z' },
      { id: 'fine', root: root(), status: 'not-git', lastOpenedAt: '2026-10-11T00:00:00.000Z' },
    ];
    const { contexts } = makeContexts(projects);
    try {
      expect(await contexts.warmAll(projects)).toEqual(['fine']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('broken');
      expect(contexts.peek('broken')).toBeUndefined();

      rmSync(join(broken, '.ai/cezar'));
      expect((await contexts.context('broken')).id).toBe('broken');
    } finally {
      contexts.disposeAll();
    }
  });

  it('shares one build with a click that lands while the warm-up is building', async () => {
    const projects: ProjectWarmCandidate[] = [{ id: 'a', root: root(), status: 'not-git' }];
    const { contexts, built } = makeContexts(projects);
    try {
      const warming = contexts.warmAll(projects);
      const clicked = await contexts.context('a');
      await warming;
      expect(built).toEqual(['a']);
      expect(contexts.peek('a')).toBe(clicked);
    } finally {
      contexts.disposeAll();
    }
  });

  it('stops at shutdown: a build in flight is torn down and nothing after it starts', async () => {
    const projects: ProjectWarmCandidate[] = [
      { id: 'first', root: root(), status: 'not-git', lastOpenedAt: '2026-10-12T00:00:00.000Z' },
      { id: 'second', root: root(), status: 'not-git', lastOpenedAt: '2026-10-11T00:00:00.000Z' },
    ];
    const { contexts, built } = makeContexts(projects);
    const warming = contexts.warmAll(projects);
    contexts.disposeAll();
    expect(await warming).toEqual([]);
    expect(built).toEqual([]);
    expect(contexts.ids()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('tears down a build that finishes after disposeAll instead of registering it', async () => {
    const projects: ProjectWarmCandidate[] = [{ id: 'late', root: root(), status: 'not-git' }];
    const { contexts, built } = makeContexts(projects);
    const building = contexts.context('late');
    contexts.disposeAll();
    await expect(building).rejects.toBeInstanceOf(ProjectContextsClosedError);
    expect(built).toEqual([]);
    expect(contexts.ids()).toEqual([]);
    // The map stays usable: a later access builds normally.
    expect((await contexts.context('late')).id).toBe('late');
    contexts.disposeAll();
  });

  it('tears down a build that dispose(id) overtook, even one that started after the removal began (#667)', async () => {
    // Project removal: the registry row is deleted, then `dispose(id)`. A warm build that read the
    // registry just before that commit must not register the removed project afterwards.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ownership = { acquire: () => gate } as unknown as CockpitOwnership;
    const contexts = new ProjectContexts({ listProjects: async () => [{ id: 'gone', root: root(), status: 'not-git' }], ownership });
    const built: string[] = [];
    contexts.onContextBuilt((ctx) => built.push(ctx.id));
    const building = contexts.context('gone');
    expect(contexts.dispose('gone')).toBe(false);
    release();
    await expect(building).rejects.toBeInstanceOf(ProjectContextsClosedError);
    expect(built).toEqual([]);
    expect(contexts.peek('gone')).toBeUndefined();
    contexts.disposeAll();
  });

  it('skips a project removed after the warm-up listed it, without a warning', async () => {
    const kept = root();
    const listed: ProjectWarmCandidate[] = [
      { id: 'removed', root: root(), status: 'not-git', lastOpenedAt: '2026-10-12T00:00:00.000Z' },
      { id: 'kept', root: kept, status: 'not-git', lastOpenedAt: '2026-10-11T00:00:00.000Z' },
    ];
    // The registry no longer holds `removed`: its build answers unknown-project.
    const contexts = new ProjectContexts({ listProjects: async () => [listed[1]!] });
    try {
      expect(await contexts.warmAll(listed)).toEqual(['kept']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      contexts.disposeAll();
    }
  });

  it('disposes a manager whose build is still recovering, so recovery never starts work after shutdown (#667)', async () => {
    // `disposeAll` used to wait for the build to land before tearing it down. Recovery kept running
    // in between and could pump re-queued runs into agents after the server had closed.
    let releaseRecover!: () => void;
    const recovering = new Promise<void>((resolve) => { releaseRecover = resolve; });
    const recover = vi.spyOn(RunManager.prototype, 'recover').mockImplementation(async function (this: RunManager) {
      await recovering;
    });
    const projects: ProjectWarmCandidate[] = [{ id: 'busy', root: root(), status: 'not-git' }];
    const contexts = new ProjectContexts({ listProjects: async () => projects });
    const building = contexts.context('busy');
    await vi.waitFor(() => expect(recover).toHaveBeenCalled(), { timeout: HANG_GUARD_MS });
    const manager = recover.mock.contexts[0] as RunManager;

    contexts.disposeAll();

    expect((manager as unknown as { disposed: boolean }).disposed).toBe(true);
    releaseRecover();
    await expect(building).rejects.toBeInstanceOf(ProjectContextsClosedError);
    recover.mockRestore();
  });

  it('never recovers a build whose shutdown landed while it waited for the lock (#667)', async () => {
    // Before the manager exists there is nothing for `disposeAll` to stop, so the build itself
    // has to notice it went stale before it opens the store and recovers.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ownership = { acquire: () => gate } as unknown as CockpitOwnership;
    const recover = vi.spyOn(RunManager.prototype, 'recover');
    const contexts = new ProjectContexts({ listProjects: async () => [{ id: 'early', root: root(), status: 'not-git' }], ownership });
    const building = contexts.context('early');
    await Promise.resolve();
    contexts.disposeAll();
    release();
    await expect(building).rejects.toBeInstanceOf(ProjectContextsClosedError);
    expect(recover).not.toHaveBeenCalled();
    recover.mockRestore();
  });

  it('never recovers a build whose project was removed while it read the registry (#667)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const recover = vi.spyOn(RunManager.prototype, 'recover');
    const projects: ProjectWarmCandidate[] = [{ id: 'gone', root: root(), status: 'not-git' }];
    const contexts = new ProjectContexts({ listProjects: async () => { await gate; return projects; } });
    const building = contexts.context('gone');
    contexts.dispose('gone');
    release();
    await expect(building).rejects.toBeInstanceOf(ProjectContextsClosedError);
    expect(recover).not.toHaveBeenCalled();
    recover.mockRestore();
    contexts.disposeAll();
  });
});
