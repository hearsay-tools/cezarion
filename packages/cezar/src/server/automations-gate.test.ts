import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { ProjectContexts, sweepRegisteredPreviewLeftovers } from './project-context.ts';
import { ArchiveOnMergeCoordinator } from './archive-on-merge.ts';
import { CompletionActionCoordinator } from './completion-actions.ts';
import { startServer } from './start-server.ts';
import { createApp, type ServerDeps } from './server.ts';
import * as git from './git.ts';
import { createWorkspaceProjects } from './workspace-projects.ts';

// The post-listen chain reads the registry, then sweeps preview leftovers, then decides on the
// warm-up: the sweep call is the test's signal that the chain reached that decision.
vi.mock('./project-context.ts', async (original) => {
  const actual = await original<typeof import('./project-context.ts')>();
  return { ...actual, sweepRegisteredPreviewLeftovers: vi.fn(actual.sweepRegisteredPreviewLeftovers) };
});
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * Automations are on by default: only `CEZ_AUTOMATIONS=0` turns them off.
 * Off, every route of the family answers `409` naming the flag — defense in depth behind the
 * cockpit's nav gate, so a bookmarked deep link or a script cannot drive a feature the operator
 * switched off.
 *
 * Disabled readers refuse uniformly, so the UI cannot offer to create an automation
 * against a refused POST.
 *
 * The definitions on disk are never touched: the gate hides the feature, it does not delete it.
 */

const DEFINITION = {
  name: 'Review new issues',
  enabled: false as const,
  events: ['issue.opened' as const],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}' },
};

describe('automations gate (#801)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let automationId: string;
  const savedAutomations = process.env.CEZ_AUTOMATIONS;
  const savedRemote = process.env.CEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-automations-gate-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    // A pre-existing definition, written while the feature was on: the gate must hide it and
    // must never destroy it.
    const seed = AutomationStore.open(dataDir);
    automationId = seed.create(DEFINITION).id;
    process.env.CEZ_AUTOMATIONS = '0';
    delete process.env.CEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
    else process.env.CEZ_AUTOMATIONS = savedAutomations;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
  });

  const app = (over: Partial<ServerDeps> = {}) =>
    createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  describe('off (CEZ_AUTOMATIONS=0)', () => {
    /** Every route of the feature. */
    const routes = (id: string): Array<[label: string, path: string, init?: RequestInit]> => [
      ['GET /automations', '/api/v1/automations'],
      ['POST /automations', '/api/v1/automations', json(DEFINITION)],
      ['GET /automations/:id', `/api/v1/automations/${id}`],
      ['PUT /automations/:id', `/api/v1/automations/${id}`, json({ ...DEFINITION, revision: 1 }, 'PUT')],
      ['DELETE /automations/:id', `/api/v1/automations/${id}`, { method: 'DELETE' }],
      ['POST /automations/:id/enable', `/api/v1/automations/${id}/enable`, json({ revision: 1 })],
      ['POST /automations/:id/pause', `/api/v1/automations/${id}/pause`, json({ revision: 1 })],
      ['POST /automations/:id/check', `/api/v1/automations/${id}/check`, json({ mode: 'preview' })],
      ['POST /automations/:id/run', `/api/v1/automations/${id}/run`, { method: 'POST' }],
      ['GET /automation-log', '/api/v1/automation-log'],
      ['POST /automation-log/:receiptId/retry', '/api/v1/automation-log/no-such-receipt/retry', { method: 'POST' }],
      ['GET /automation-checks/:checkId', '/api/v1/automation-checks/no-such-check'],
    ];

    it.each(routes('will-be-replaced').map(([label]) => label))(
      '%s answers 409 with a reason naming the flag',
      async (label) => {
        const [, path, init] = routes(automationId).find(([name]) => name === label)!;
        const res = await apiRequest(app(), path, init);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toContain('CEZ_AUTOMATIONS');
      },
    );

    // The regression this file exists for. Both automation families are mounted with
    // `.route('/', …)` alongside a dozen unrelated sub-apps, so a guard registered as `use('*')`
    // instead of on explicit paths would 409 the ENTIRE `/api/v1` surface — including the
    // CORS-open discovery route the cockpit boots from.
    it('gates only its own family — health and its neighbours are untouched', async () => {
      const built = app();
      expect((await apiRequest(built, '/api/v1/health')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/runs')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/run-summaries')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/workflows')).status).toBe(200);
    });

    it('gates the project-scoped mirror too, not just the boot alias', async () => {
      const res = await apiRequest(app(), '/api/v1/p/default/automations');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_AUTOMATIONS');
    });

    it('hides definitions without destroying them — flipping the flag brings them back', async () => {
      await apiRequest(app(), '/api/v1/automations');
      await apiRequest(app(), `/api/v1/automations/${automationId}`, { method: 'DELETE' });
      process.env.CEZ_AUTOMATIONS = '1';
      const res = await apiRequest(app(), '/api/v1/automations');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { automations: Array<{ id: string; name: string }> };
      expect(body.automations).toHaveLength(1);
      expect(body.automations[0]).toMatchObject({ id: automationId, name: DEFINITION.name });
    });

    it('reports the capability as off on health, which is what the nav gate reads', async () => {
      const res = await apiRequest(app(), '/api/v1/health');
      expect(((await res.json()) as { capabilities: { automations: boolean } }).capabilities.automations)
        .toBe(false);
    });
  });

  describe('on (the default)', () => {
    beforeEach(() => {
      delete process.env.CEZ_AUTOMATIONS;
    });

    it('serves the real definitions', async () => {
      const res = await apiRequest(app(), '/api/v1/automations');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { automations: Array<{ id: string }> };
      expect(body.automations.map((item) => item.id)).toEqual([automationId]);
    });

    it('an unknown id still 404s — the gate is not swallowing it', async () => {
      const res = await apiRequest(app(), '/api/v1/automations/nope');
      expect(res.status).toBe(404);
    });

    it('a malformed body still 400s ahead of the 404 — validator order is unchanged', async () => {
      const res = await apiRequest(app(), '/api/v1/automations/nope/check', json({ mode: 'nonsense' }));
      expect(res.status).toBe(400);
    });

    it('reports the capability as on', async () => {
      const res = await apiRequest(app(), '/api/v1/health');
      expect(((await res.json()) as { capabilities: { automations: boolean } }).capabilities.automations)
        .toBe(true);
    });
  });

  /**
   * The flag has to remove the BEHAVIOR, not only the UI and the API: `WorkspaceAutomationScheduler`
   * is what polls GitHub on a timer and launches runs off what it finds, and a cockpit whose
   * operator switched automations off must make no GitHub requests on their behalf.
   *
   * Asserted at `startServer`, because that is where the scheduler is wired — `createApp` never
   * constructs one. The server binds an ephemeral loopback port and is closed immediately; nothing
   * here talks to the network (`CEZ_DRY_RUN=1`) or to a real agent CLI.
   */
  describe('background scheduler', () => {
    const savedHome = process.env.CEZ_HOME;
    const savedDryRun = process.env.CEZ_DRY_RUN;
    let home: string;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'cez-automations-gate-home-'));
      useTestHome(home ? Home.sandbox(home) : undefined);
      process.env.CEZ_DRY_RUN = '1';
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
      if (savedHome === undefined) useTestHome(undefined);
      else useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
      vi.restoreAllMocks();
    });

    const WARMUP_MS = 15_000;

    /** Boot on an ephemeral port, wait until warmup has started or skipped the scheduler, then close. */
    const boot = async (warmupHoldMs = 0): Promise<void> => {
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
      const sweep = vi.mocked(sweepRegisteredPreviewLeftovers);
      const { sweepRegisteredPreviewLeftovers: originalSweep } = await vi.importActual<typeof import('./project-context.ts')>('./project-context.ts');
      sweep.mockClear();
      sweep.mockImplementation((...args) => {
        if (warmupHoldMs > 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, warmupHoldMs);
        }
        return originalSweep(...args);
      });
      const server = startServer(
        { home: testHome(), repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' },
        0,
      );
      try {
        await new Promise<void>((resolve) => server.once('listening', () => resolve()));
        if (process.env.CEZ_AUTOMATIONS !== '0') {
          await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), {
            timeout: WARMUP_MS,
            interval: 10,
          });
        } else {
          await vi.waitFor(() => expect(sweep).toHaveBeenCalled(), {
            timeout: WARMUP_MS,
            interval: 10,
          });
          // The gate runs in the same turn as the sweep. Past it, the chain to `start()` is
          // microtasks and synchronous store opens once Git inspection answers at once, so one
          // real event-loop turn would let an ungated chain reach `start()`.
          await setImmediate();
        }
      } finally {
        server.close();
      }
      expect(started).toHaveBeenCalledTimes(process.env.CEZ_AUTOMATIONS !== '0' ? 1 : 0);
    };

    it('never starts polling while the flag is off', async () => {
      vi.spyOn(git, 'getRepoInfo').mockResolvedValue(null);
      await boot();
    }, WARMUP_MS + 5_000);

    it('starts by default without an environment flag', async () => {
      delete process.env.CEZ_AUTOMATIONS;
      await boot();
    }, WARMUP_MS + 5_000);

    it.each(['project discovery', 'Git inspection'] as const)('does not restart after closing during %s', async (stage) => {
      delete process.env.CEZ_AUTOMATIONS;
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start').mockResolvedValue();
      // Only automation startup may inspect the secondary project. Health uses the boot root.
      vi.spyOn(ProjectContexts.prototype, 'warmAll').mockResolvedValue([]);
      vi.spyOn(ArchiveOnMergeCoordinator.prototype, 'start').mockImplementation(() => {});
      vi.spyOn(CompletionActionCoordinator.prototype, 'start').mockImplementation(() => {});
      const automationRoot = join(repoRoot, 'automation-only');
      mkdirSync(automationRoot);
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const workspace = createWorkspaceProjects({ home: testHome(), bootRoot: repoRoot });
      vi.spyOn(workspace, 'listProjects').mockImplementation(async () => {
        if (stage === 'project discovery') {
          entered();
          await pending;
        }
        return [{ id: 'automation-only', name: 'Automation only', root: automationRoot,
          addedAt: '', lastOpenedAt: '', source: 'local' as const, status: 'ok' as const }];
      });
      vi.spyOn(git, 'getRepoInfo').mockImplementation(async (root) => {
        if (stage === 'Git inspection' && root === automationRoot) {
          entered();
          await pending;
        }
        return null;
      });
      const server = startServer({ home: testHome(), repoRoot, store, workspaceProjects: workspace,
        manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' }, 0);
      try {
        await reached;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        release();
        // One real event-loop turn drains the released startup chain; these probes do no I/O.
        await setImmediate();
        expect(started).not.toHaveBeenCalled();
      } finally {
        release();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('starts even when the post-listen chain outlasts a 50ms guess', async () => {
      process.env.CEZ_AUTOMATIONS = '1';
      await boot(80);
    }, WARMUP_MS + 5_000);
  });
});
