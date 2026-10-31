import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, startServer } from './server.ts';

/**
 * hearsay-tools/cezarion#2320: `createApp` and `startServer` share one context-discovery boundary.
 * With CEZ_SINGLE_PROJECT=1 a registered non-launch project is unknown (404) through both entry
 * points, and its store never opens; with the mode off it stays discoverable. Neither path
 * injects `contexts`, so each one exercises the supplier its entry point builds.
 */
describe('single-project context discovery', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN, warmup: process.env.CEZ_PROJECT_WARMUP, single: process.env.CEZ_SINGLE_PROJECT };
  let home: string;
  let bootRoot: string;
  let otherRoot: string;
  let bootId: string;
  let otherId: string;
  const cleanups: (() => void)[] = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-discovery-home-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-discovery-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-discovery-other-'));
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    // Warm-up would build the other project with no request; this test asks about the lookup only.
    process.env.CEZ_PROJECT_WARMUP = '0';
    delete process.env.CEZ_SINGLE_PROJECT;
    clearProjectProbeCache();
    bootId = (await registerProject(bootRoot)).id;
    otherId = (await registerProject(otherRoot)).id;
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.restoreAllMocks();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_DRY_RUN', saved.dryRun], ['CEZ_PROJECT_WARMUP', saved.warmup], ['CEZ_SINGLE_PROJECT', saved.single]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const bootDeps = () => {
    const store = RunStore.open(join(bootRoot, '.ai/cezar'), { keepLive: true });
    cleanups.push(() => store.close());
    return { repoRoot: bootRoot, bootProjectId: bootId, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' };
  };

  const viaCreateApp = async (path: string): Promise<number> => {
    const app = createApp(bootDeps());
    return (await apiRequest(app, path)).status;
  };

  const viaStartServer = async (path: string): Promise<number> => {
    const server = startServer(bootDeps(), 0);
    cleanups.push(() => server.close());
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return (await fetch(`http://127.0.0.1:${port}${path}`)).status;
  };

  const otherStoreOpens = (open: MockInstance<typeof RunStore.open>) =>
    open.mock.calls.filter(([dataDir]) => dataDir === join(otherRoot, '.ai/cezar')).length;

  for (const [entry, request] of [['createApp', viaCreateApp], ['startServer', viaStartServer]] as const) {
    it(`${entry}: single-project mode answers 404 for a registered non-launch project and builds no context`, async () => {
      process.env.CEZ_SINGLE_PROJECT = '1';
      const open = vi.spyOn(RunStore, 'open');
      expect(await request(`/api/v1/p/${otherId}/runs`)).toBe(404);
      expect(otherStoreOpens(open)).toBe(0);
      // The hidden row stays registered, so turning the mode off restores it with no migration.
      expect((await loadWorkspaceConfig()).projects.map((project) => project.id).sort()).toEqual([bootId, otherId].sort());
    }, 15_000);

    it(`${entry}: without single-project mode a registered non-launch project is discoverable`, async () => {
      const open = vi.spyOn(RunStore, 'open');
      expect(await request(`/api/v1/p/${otherId}/runs`)).toBe(200);
      expect(otherStoreOpens(open)).toBe(1);
    }, 15_000);
  }
});
