import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { startServer } from './server.ts';

/**
 * #774: the cockpit hands every project's RunManager the address it BOUND (`--port 0` asks for an
 * ephemeral one) and that project's own id, so `cez automation` inside an agent calls this
 * cockpit and never probes ports. A project built after listening gets it too.
 */
describe('startServer cockpit address', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN, warmup: process.env.CEZ_PROJECT_WARMUP, single: process.env.CEZ_SINGLE_PROJECT };
  let home: string;
  let bootRoot: string;
  let otherRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-address-home-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-address-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-address-other-'));
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_PROJECT_WARMUP;
    delete process.env.CEZ_SINGLE_PROJECT;
    clearProjectProbeCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_DRY_RUN', saved.dryRun], ['CEZ_PROJECT_WARMUP', saved.warmup], ['CEZ_SINGLE_PROJECT', saved.single]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('addresses the boot manager and every built project with the bound port and its own id', async () => {
    const bootId = (await registerProject(bootRoot)).id;
    const otherId = (await registerProject(otherRoot)).id;
    const store = RunStore.open(join(bootRoot, '.ai/cezar'), { keepLive: true });
    const contexts = new ProjectContexts({ listProjects });
    const setCockpitAddress = vi.fn();
    const server = startServer({
      repoRoot: bootRoot,
      bootProjectId: bootId,
      store,
      manager: { isActive: () => false, setCockpitAddress } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    }, 0);
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(setCockpitAddress).toHaveBeenCalledWith({ origin, projectId: bootId });
      // Built by the background warm-up after listening.
      await vi.waitFor(() => expect(contexts.peek(otherId)).toBeDefined(), { timeout: 10_000, interval: 20 });
      expect(contexts.peek(otherId)!.manager.cockpitAddress()).toEqual({ origin, projectId: otherId });
    } finally {
      server.close();
      contexts.disposeAll();
      store.close();
    }
  }, 15_000);
});
