import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { SkillsUpdateCoordinator } from '../skills-update.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { startServer } from './server.ts';

/**
 * Boot warm-up (#667), asserted at `startServer` because that is where it is wired: once the
 * server listens, every registered project other than the boot one gets its context built with
 * no request, so the first click on it finds the project ready. `CEZ_PROJECT_WARMUP=0` turns it
 * off and leaves every project lazy, as before. The server binds an ephemeral loopback port.
 */
describe('startServer project warm-up', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN, warmup: process.env.CEZ_PROJECT_WARMUP };
  let home: string;
  let bootRoot: string;
  let otherRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-warmup-home-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-warmup-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-warmup-other-'));
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_PROJECT_WARMUP;
    clearProjectProbeCache();
    // The skills-update coordinator starts beside the warm-up; it is not what this file tests.
    vi.spyOn(SkillsUpdateCoordinator.prototype, 'start').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_DRY_RUN', saved.dryRun], ['CEZ_PROJECT_WARMUP', saved.warmup]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const boot = async (): Promise<{ contexts: ProjectContexts; bootId: string; otherId: string; close: () => void }> => {
    const bootId = (await registerProject(bootRoot)).id;
    const otherId = (await registerProject(otherRoot)).id;
    const store = RunStore.open(join(bootRoot, '.ai/cezar'), { keepLive: true });
    const contexts = new ProjectContexts({ listProjects });
    const server = startServer({
      repoRoot: bootRoot,
      bootProjectId: bootId,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    }, 0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    return {
      contexts,
      bootId,
      otherId,
      close: () => {
        server.close();
        contexts.disposeAll();
        store.close();
      },
    };
  };

  it('builds every other registered project after listening, with no request', async () => {
    const { contexts, bootId, otherId, close } = await boot();
    try {
      await vi.waitFor(() => expect(contexts.peek(otherId)).toBeDefined(), { timeout: 10_000, interval: 20 });
      // The boot project already has its context; the map never opens a second store for it.
      expect(contexts.peek(bootId)).toBeUndefined();
    } finally {
      close();
    }
  }, 15_000);

  it('leaves every project lazy under CEZ_PROJECT_WARMUP=0', async () => {
    process.env.CEZ_PROJECT_WARMUP = '0';
    const warmAll = vi.spyOn(ProjectContexts.prototype, 'warmAll');
    const { contexts, otherId, close } = await boot();
    try {
      // The background services started (the coordinator sits beside the warm-up) ...
      await vi.waitFor(() => expect(SkillsUpdateCoordinator.prototype.start).toHaveBeenCalled(), { timeout: 10_000, interval: 20 });
      // ... and skipped the warm-up.
      expect(warmAll).not.toHaveBeenCalled();
      expect(contexts.peek(otherId)).toBeUndefined();
    } finally {
      close();
    }
  }, 15_000);
});
