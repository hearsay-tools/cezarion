import { projectPaths } from '../project-paths.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { registerPreviewServer } from '../preview/run-tools.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { emitUsageForTest } from '../core/process-usage.ts';
import type { RunManager } from '../workflows/run.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import type { PreviewHost } from '../preview/host.ts';
import { ProjectContextError, ProjectContexts, type ProjectContextSource } from './project-context.ts';
import { seedRuns, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { createRunner } from '../core/runner-factory.ts';

const observed = vi.hoisted(() => ({
  options: new WeakMap<object, ConstructorParameters<typeof RunManager>[2]>(),
  subscriptions: [] as Array<{ listener: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> }>,
}));
vi.mock('../workflows/run.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../workflows/run.ts')>();
  return { ...actual, RunManager: class extends actual.RunManager {
    constructor(...args: ConstructorParameters<typeof RunManager>) {
      super(...args);
      observed.options.set(this, args[2]);
    }
  } };
});
// Every preview sweep a context build starts, so a test can await the one that decides its outcome.
const previewSweeps = vi.hoisted(() => [] as Promise<number>[]);
vi.mock('../preview/dev-server.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../preview/dev-server.ts')>();
  return { ...actual, sweepPreviewLeftovers: (...args: Parameters<typeof actual.sweepPreviewLeftovers>) => {
    const sweep = actual.sweepPreviewLeftovers(...args);
    previewSweeps.push(sweep);
    return sweep;
  } };
});
vi.mock('../core/process-usage.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../core/process-usage.ts')>();
  return { ...actual, onUsage: (listener: Parameters<typeof actual.onUsage>[0]) => {
    const observedListener = vi.fn(listener);
    const unsubscribe = vi.fn(actual.onUsage(observedListener));
    observed.subscriptions.push({ listener: observedListener, unsubscribe });
    return unsubscribe;
  } };
});

/**
 * Lazy per-project context map (spec 2026-07-20-multi-project-workspace,
 * step 2.1): nothing instantiated until first access, one instance per id,
 * missing roots never built, and a disposed context's manager stops
 * receiving usage-sampler ticks. The registry is injected as a plain
 * `listProjects` resolver so nothing here touches `~/.cezar`.
 */
describe('ProjectContexts', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    observed.subscriptions.length = 0;
    rootA = mkdtempSync(join(tmpdir(), 'cez-ctx-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'cez-ctx-b-'));
  });

  afterEach(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  function makeContexts(projects: ProjectContextSource[]): ProjectContexts {
    return new ProjectContexts({ createRunner, home: testHome(), listProjects: async () => projects });
  }

  it('leases a cold store without recovery, and context build waits for its release', async () => {
    const dataDir = join(rootA, '.ai/cezar');
    seedRuns(dataDir, [{ id: 'interrupted', title: 'task', task: 'task', workflow: 'quick-task', steps: [], status: RUN_STATUS.running, tokensUsed: 0, archived: false, createdAt: '2026-01-01T00:00:00.000Z' }]);
    const prepared = vi.fn();
    const contexts = new ProjectContexts({ createRunner, home: testHome(), listProjects: async () => [{ id: 'a', root: rootA, status: 'not-git' }], prepareManager: prepared });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const lease = contexts.withMaintenanceStore('a', async (store, current) => {
      expect(current()).toBe(true);
      expect(store.getRun('interrupted')?.status).toBe('running');
      entered(); await gate;
      expect(contexts.peek('a')).toBeUndefined();
    });
    await started;
    expect(prepared).not.toHaveBeenCalled();
    expect(contexts.ids()).toEqual([]);
    expect(readPersistedRuns(dataDir)[0].status).toBe('running');
    const build = contexts.context('a');
    release(); await lease; await build;
    expect(prepared).toHaveBeenCalledTimes(1);
    contexts.disposeAll();
  });

  it('invalidates a maintenance lease on removal', async () => {
    seedRuns(join(rootA, '.ai/cezar'), []);
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    await contexts.withMaintenanceStore('a', async (_store, current) => {
      expect(current()).toBe(true); contexts.dispose('a'); expect(current()).toBe(false);
    });
    expect(contexts.ids()).toEqual([]);
  });

  it('imports a legacy-only cold store without normalizing live work or building a manager', async () => {
    const dataDir = join(rootA, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    const legacy = [{ id: 'interrupted', title: 'task', task: 'task', workflow: 'quick-task', steps: [], status: RUN_STATUS.running, tokensUsed: 0, archived: false, createdAt: '2026-01-01T00:00:00.000Z' }];
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify(legacy));
    const prepared = vi.fn();
    const contexts = new ProjectContexts({ createRunner, home: testHome(), listProjects: async () => [{ id: 'a', root: rootA, status: 'not-git' }], prepareManager: prepared });
    const visited = vi.fn();
    await contexts.withMaintenanceStore('a', async store => {
      visited();
      expect(store.getRun('interrupted')?.status).toBe('running');
    });
    expect(visited).toHaveBeenCalledOnce();
    expect(readPersistedRuns(dataDir)).toEqual(legacy);
    expect(prepared).not.toHaveBeenCalled();
    expect(contexts.ids()).toEqual([]);
    contexts.disposeAll();
  });

  it('builds lazily: nothing on construction, first access builds, second returns the same instance', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);

    // Construction instantiated nothing — no store dir, no launch-key.
    expect(existsSync(join(rootA, '.ai/cezar'))).toBe(false);
    expect(existsSync(join(rootB, '.ai/cezar'))).toBe(false);
    expect(contexts.ids()).toEqual([]);

    const first = await contexts.context('a');
    expect(first.id).toBe('a');
    expect(first.dataDir).toBe(projectPaths(rootA).write);
    expect(first.launchKey).not.toBe('');
    expect(existsSync(join(projectPaths(rootA).write, 'launch-key'))).toBe(true);
    // Only the accessed project was built.
    expect(existsSync(join(rootB, '.ai/cezar'))).toBe(false);
    expect(contexts.ids()).toEqual(['a']);

    const second = await contexts.context('a');
    expect(second).toBe(first);
  });

  it('hands the workspace preview host to every lazily built manager and store (#781)', async () => {
    vi.stubEnv('CEZ_PREVIEW', '1');
    const release = vi.fn(async () => undefined);
    const preview = { portOwner: () => undefined, probe: async () => false, release, ownsServer: () => false } as unknown as PreviewHost;
    const contexts = new ProjectContexts({ createRunner, home: testHome(), listProjects: async () => [{ id: 'a', root: rootA, status: 'not-git' }], preview, cezarPort: () => 4321 });
    try {
      const ctx = await contexts.context('a');
      const run = ctx.store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
      ctx.store.updateRun(run.id, { worktreePath: rootA });
      // Without the host every registration answers `headless`, and without the port getter the
      // cockpit's own port registers.
      expect((await registerPreviewServer(ctx.store, ctx.manager.previewHost, observed.options.get(ctx.manager)?.cezarPort, () => false, run.id, { command: 'npm run dev', port: 4321 })).code).toBe('cezar_port');
      expect((await registerPreviewServer(ctx.store, ctx.manager.previewHost, observed.options.get(ctx.manager)?.cezarPort, () => false, run.id, { command: 'npm run dev', port: 5173 })).code).toBe('registered');
      ctx.store.deleteRun(run.id);
      expect(release).toHaveBeenCalledWith(run.id, { deleteProfile: true, dataDir: ctx.dataDir });
    } finally {
      contexts.disposeAll();
      vi.unstubAllEnvs();
    }
  });

  it('releases a removed project\'s previews, and a rebuild never sweeps a server this process runs (#781)', async () => {
    const fixture = fileURLToPath(new URL('../preview/__fixtures__/fake-dev-server.mjs', import.meta.url));
    const child: ChildProcess = spawn(process.execPath, [fixture, '--port', '0', '--delay', '600000'], { detached: true, stdio: 'ignore' });
    const release = vi.fn(async () => undefined);
    const preview = { portOwner: () => undefined, probe: async () => false, release, ownsServer: () => false } as unknown as PreviewHost;
    const contexts = new ProjectContexts({ createRunner, home: testHome(), listProjects: async () => [{ id: 'a', root: rootA, status: 'not-git' }], preview });
    try {
      const ctx = await contexts.context('a');
      const run = ctx.store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
      // A dev server this process started after the boot sweep: its pid record is on disk.
      const dir = join(ctx.dataDir, 'preview', run.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '5173.pid.json'), JSON.stringify({ pid: child.pid, pgid: child.pid, startToken: processStartToken(child.pid!) }));

      expect(contexts.dispose('a')).toBe(true);
      expect(release).toHaveBeenCalledWith(run.id);

      await contexts.context('a');
      // Any sweep the rebuild started has removed the record and killed the group by now.
      await Promise.all(previewSweeps);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(existsSync(join(dir, '5173.pid.json'))).toBe(true);
    } finally {
      contexts.disposeAll();
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('dedupes concurrent builds of the same project into one instance', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const [one, two] = await Promise.all([contexts.context('a'), contexts.context('a')]);
    expect(one).toBe(two);
  });

  it('arms project cleanup only after recovery and once per live context', async () => {
    const order: string[] = [];
    const contexts = new ProjectContexts({ createRunner, home: testHome(),
      listProjects: async () => [{ id: 'a', root: rootA, status: 'not-git' }],
      prepareManager: () => { order.push('prepare'); },
      afterRecover: () => { order.push('recovered'); },
    });
    await contexts.context('a');
    await contexts.context('a');
    expect(order).toEqual(['prepare', 'recovered']);
    contexts.disposeAll();
  });

  it('uses the injected coordinator-owned automation store', async () => {
    const automationStore = AutomationStore.open(join(rootA, '.ai/cezar'));
    const resolveAutomationStore = vi.fn(() => automationStore);
    const contexts = new ProjectContexts({ createRunner, home: testHome(),
      listProjects: async () => [{ id: 'a', root: rootA, status: 'not-git' }],
      automationStore: resolveAutomationStore,
    });
    const context = await contexts.context('a');
    expect(context.automationStore).toBe(automationStore);
    expect(resolveAutomationStore).toHaveBeenCalledWith('a', rootA);
    contexts.disposeAll();
  });

  it('never instantiates a missing-root project (even when the directory happens to exist)', async () => {
    const contexts = makeContexts([{ id: 'gone', root: rootA, status: 'missing' }]);
    await expect(contexts.context('gone')).rejects.toMatchObject({
      name: 'ProjectContextError',
      reason: 'missing-root',
      projectId: 'gone',
    });
    // Not built, and nothing written under the root.
    expect(contexts.peek('gone')).toBeUndefined();
    expect(existsSync(join(rootA, '.ai/cezar'))).toBe(false);
  });

  it('throws unknown-project for an id the registry does not hold', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    await expect(contexts.context('nope')).rejects.toMatchObject({
      name: 'ProjectContextError',
      reason: 'unknown-project',
      projectId: 'nope',
    });
    expect(contexts.ids()).toEqual([]);
  });

  it('exposes the failure as a typed error instance', async () => {
    const contexts = makeContexts([]);
    const err = await contexts.context('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectContextError);
  });

  it('dispose(): the manager receives no further usage ticks and the store is flushed and closed', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const ctx = await contexts.context('a');
    const run = ctx.store.createRun({ title: 'pending', workflow: 'w', task: 't', steps: [] });
    const { listener: spy, unsubscribe } = observed.subscriptions.at(-1)!;

    emitUsageForTest({});
    expect(spy).toHaveBeenCalledTimes(1);

    expect(contexts.dispose('a')).toBe(true);
    emitUsageForTest({});
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1); // unsubscribed — no further ticks
    // Store closed: the pending row landed on disk despite the debounced save, and a late write
    // to the disposed store saves nothing.
    expect(readPersistedRuns(projectPaths(rootA).write).map((saved) => saved.id)).toEqual([run.id]);
    ctx.store.updateRun(run.id, { title: 'after dispose' });
    ctx.store.flush();
    expect(readPersistedRuns(projectPaths(rootA).write)[0]?.title).toBe('pending');
    expect(ctx.store.listenerCount('event')).toBe(0);

    // Disposed id is gone from the map; the next access builds a fresh context.
    expect(contexts.peek('a')).toBeUndefined();
    const rebuilt = await contexts.context('a');
    expect(rebuilt).not.toBe(ctx);
    contexts.dispose('a');
  });

  it('onContextBuilt: fires once per build (not cached hits), unsubscribes cleanly, and a throwing listener never fails the build', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);
    const built: string[] = [];
    const off = contexts.onContextBuilt((ctx) => built.push(ctx.id));
    contexts.onContextBuilt(() => {
      throw new Error('subscriber boom');
    });

    await contexts.context('a');
    expect(built).toEqual(['a']); // the throwing listener didn't fail the build
    await contexts.context('a');
    expect(built).toEqual(['a']); // cached hit — no re-notify

    off();
    const b = await contexts.context('b');
    expect(b.id).toBe('b'); // built fine with only the throwing listener left
    expect(built).toEqual(['a']); // unsubscribed — not notified for b
    contexts.disposeAll();
  });

  it('dispose() of a never-built project is a no-op returning false', () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    expect(contexts.dispose('a')).toBe(false);
  });

  it('disposeAll() tears down every built context', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);
    await contexts.context('a');
    await contexts.context('b');
    const [subscriptionA, subscriptionB] = observed.subscriptions.slice(-2);

    contexts.disposeAll();
    expect(contexts.ids()).toEqual([]);
    emitUsageForTest({});
    expect(subscriptionA!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriptionB!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriptionA!.listener).not.toHaveBeenCalled();
    expect(subscriptionB!.listener).not.toHaveBeenCalled();
  });
});
