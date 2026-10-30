import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shellQuote } from '../core/shell-env.ts';
import { RunStore } from '../runs/store.ts';
import * as git from '../server/git.ts';
import { WorkspaceSemaphore, type WorkspaceResourceLimits } from '../workspace/semaphore.ts';
import { TrackedWork } from './run/tracked-work.ts';
import type { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * A project opened before its first commit keeps the one-task fallback only until it has a
 * usable repository (hearsay-tools/cezarion#2257). The manager's own minute-scale timers are
 * fired by hand, so "within 60 seconds" is measured on the timers the manager armed.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const INSTANT: WorkflowDef = { name: 'instant', source: 'built-in', steps: [{ id: 'noop', command: 'node -e ""' }] };
const settled = ['done', 'failed', 'cancelled', 'review'];

async function waitFor(predicate: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('Git rediscovery for a project opened before its first commit (hearsay-tools/cezarion#2257)', () => {
  let parent: string;
  const releases: Array<() => void> = [];
  const managers: RunManager[] = [];
  const roots: string[] = [];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    parent = realpathSync(mkdtempSync(join(tmpdir(), 'cez-rediscover-')));
    saved.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    saved.GIT_CEILING_DIRECTORIES = process.env.GIT_CEILING_DIRECTORIES;
    process.env.CEZ_DRY_RUN = '1';
    // A task TMPDIR can sit inside a checkout: stop Git discovery at the fixture parent.
    process.env.GIT_CEILING_DIRECTORIES = parent;
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const root of roots.splice(0)) await drainFixtureManagers(root);
    for (const manager of managers.splice(0)) manager.dispose();
    vi.restoreAllMocks();
    rmSync(parent, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A project folder with no repository, its manager, and the manager's minute-scale timers. */
  function project(limitsFor: (root: string) => Partial<WorkspaceResourceLimits> = () => ({}), prepare = (_root: string) => {}) {
    const root = mkdtempSync(join(parent, 'project-'));
    roots.push(root);
    prepare(root);
    const store = RunStore.open(join(root, '.ai/cezar'));
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 16, ...limitsFor(root) } });
    const work = new TrackedWork();
    const original = globalThis.setInterval;
    const timers: Array<{ callback: () => void; ms: number }> = [];
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms?: number) => {
      // The 2 s usage sampler is shared process state; only the manager's scheduler ticks count.
      if ((ms ?? 0) >= 10_000) timers.push({ callback, ms: ms ?? 0 });
      return original(callback, ms);
    }) as typeof setInterval);
    const manager = createFixtureManager(store, root, { semaphore, work });
    spy.mockRestore();
    managers.push(manager);
    /** Fire every scheduler tick that falls inside the next `ms`, then let the pumps it began finish. */
    const elapse = async (ms: number) => {
      for (const timer of timers) for (let at = timer.ms; at <= ms; at += timer.ms) timer.callback();
      const pumps = [...work.pending].filter(([, label]) => label === 'pump').map(([promise]) => promise);
      await Promise.all(pumps);
    };
    return { root, store, manager, elapse };
  }

  function holder(): WorkflowDef {
    const gate = join(mkdtempSync(join(parent, 'gate-')), 'release');
    releases.push(() => writeFileSync(gate, ''));
    const script = "const fs=require('node:fs');const gate=process.argv[1];const poll=()=>fs.existsSync(gate)?undefined:setTimeout(poll,5);poll()";
    return {
      name: 'slot-holder',
      source: 'built-in',
      steps: [{ id: 'hold', command: `${shellQuote(process.execPath)} -e ${shellQuote(script)} ${shellQuote(gate)}` }],
    };
  }

  function initGit(root: string): void {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
    execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
  }

  function commit(root: string): void {
    execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'first'], { cwd: root });
  }

  /** One task holding a slot in the folder and one queued behind the fallback. */
  async function heldQueue(p: ReturnType<typeof project>) {
    const first = p.manager.startRun(holder(), { task: 'hold the only fallback slot' });
    await waitFor(() => p.store.getRun(first.id)?.status === 'running', 'the first task to run');
    const second = p.manager.startRun(INSTANT, { task: 'queued behind the fallback' });
    await p.elapse(0);
    expect(p.store.getRun(second.id)?.status).toBe('queued');
    return { first, second };
  }

  it('starts the queued task within 60 s of the first commit while the first task keeps running', async () => {
    const p = project();
    const { first, second } = await heldQueue(p);

    initGit(p.root);
    commit(p.root);
    await p.elapse(60_000);

    await waitFor(() => settled.includes(p.store.getRun(second.id)?.status ?? ''), 'the queued task to finish', 30_000);
    expect(p.store.getRun(second.id)?.status).toBe('done');
    expect(p.store.getRun(first.id)?.status).toBe('running');
    expect(runInternals(p.manager).active.has(first.id)).toBe(true);
  }, 45_000);

  it.each([
    ['no .git', (_root: string) => {}],
    ['.git with no commit', (root: string) => { initGit(root); }],
  ])('keeps the one-task fallback for a folder with %s', async (_name, prepare) => {
    const p = project();
    const { second } = await heldQueue(p);

    prepare(p.root);
    await p.elapse(60_000);

    expect(p.store.getRun(second.id)?.status).toBe('queued');
  }, 45_000);

  it.each([
    ['workspace', (_root: string): Partial<WorkspaceResourceLimits> => ({ maxParallel: 1 })],
    ['project', (root: string): Partial<WorkspaceResourceLimits> => ({ projectLimits: new Map([[realpathSync(root), 1]]) })],
  ])('keeps the %s cap after the first commit and probes no Git while it is full', async (_name, limitsFor) => {
    const p = project(limitsFor);
    const { second } = await heldQueue(p);
    initGit(p.root);
    commit(p.root);
    const probe = vi.spyOn(git, 'getRepoInfo');

    await p.elapse(60_000);

    expect(p.store.getRun(second.id)?.status).toBe('queued');
    expect(probe).not.toHaveBeenCalled();
  }, 45_000);

  it('probes no Git on scheduler ticks when nothing is queued', async () => {
    const p = project();
    await p.elapse(0);
    const probe = vi.spyOn(git, 'getRepoInfo');

    await p.elapse(60_000);

    expect(probe).not.toHaveBeenCalled();
  });

  it('probes no Git on scheduler ticks once a repository was found', async () => {
    const p = project(() => ({ maxParallel: 1 }), (root) => { initGit(root); commit(root); });
    const first = p.manager.startRun(holder(), { task: 'hold the only slot' });
    await waitFor(() => p.store.getRun(first.id)?.status === 'running', 'the first task to run');
    const second = p.manager.startRun(INSTANT, { task: 'queued behind the workspace cap' });
    await p.elapse(0);
    const probe = vi.spyOn(git, 'getRepoInfo');

    await p.elapse(60_000);

    expect(p.store.getRun(second.id)?.status).toBe('queued');
    expect(probe).not.toHaveBeenCalled();
  }, 45_000);
});
