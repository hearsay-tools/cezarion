import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { createRunner } from '../core/runner-factory.ts';

/** The versioned surface (spec 2026-07-23-independent-server-web-packages): everything lives under `/api/v1`. */
describe('the versioned API surface', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-v1-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-v1-boot-'));
    useTestHome(home ? Home.sandbox(home) : undefined);
    process.env.CEZ_DRY_RUN = '1';
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    contexts = new ProjectContexts({ createRunner, home: testHome(), listProjects: () => listProjects(testHome())});
    await registerProject(repoRoot, undefined, testHome());
    app = createApp({ home: testHome(),
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
  });

  afterEach(() => {
    contexts.disposeAll();
    store.flush();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedHome === undefined) useTestHome(undefined);
    else useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const answer = async (path: string): Promise<{ status: number; body: string }> => {
    const res = await apiRequest(app, path);
    return { status: res.status, body: await res.text() };
  };

  it('rejects an unknown project', async () => {
    expect((await answer('/api/v1/p/nope/agent-config')).status).toBe(404);
  });

  it('serves health cross-origin — the discovery endpoint', async () => {
    // The deliberate CORS exception (spec 011): the one route a cross-origin caller may read,
    // because it is how anything discovers a running cockpit and what it speaks.
    const res = await apiRequest(app, '/api/v1/health');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
