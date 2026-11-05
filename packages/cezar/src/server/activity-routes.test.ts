import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activitySnapshotSchema } from '@open-mercato/cezar-contract/activity';
import { ActivityDemand } from '../activity/demand.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { createActivityRoutes } from './activity-routes.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';

/** `GET /api/v1/workspace/activity`: the live activity view's snapshot over HTTP. */
describe('workspace activity API', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN };
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-activity-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-activity-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-activity-other-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.close();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_DRY_RUN', saved.dryRun]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const manager = { finishBlockedReason: () => 'no open session', isActive: () => false } as unknown as RunManager;
  const get = async (path: string, contexts?: ProjectContexts) =>
    apiRequest(createApp({ repoRoot, store, manager, version: '0.0.0-test', ...(contexts ? { contexts } : {}) }), path);

  it('reads every visible project, and never builds a context for one this process has not loaded', async () => {
    const boot = await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    const run = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });
    const contexts = new ProjectContexts({ listProjects });

    const res = await get('/api/v1/workspace/activity', contexts);

    expect(res.status).toBe(200);
    const body = activitySnapshotSchema.parse(await res.json());
    expect(body.projects.map((project) => [project.projectId, project.loaded])).toEqual([[boot.id, true], [other.id, false]]);
    expect(body.projects[0]!.tasks.map((task) => [task.runId, task.title, task.status])).toEqual([[run.id, 'Boot task', run.status]]);
    expect(body.projects[0]!.name).toBe(boot.name);
    expect(contexts.ids()).toEqual([]);
    contexts.disposeAll();
  });

  it('reads one project by id, the boot alias included', async () => {
    const boot = await registerProject(repoRoot);
    const run = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });
    for (const id of ['default', boot.id]) {
      const res = await get(`/api/v1/workspace/activity?project=${id}`);
      expect(res.status).toBe(200);
      const body = activitySnapshotSchema.parse(await res.json());
      expect(body.projects.map((project) => [project.projectId, project.loaded, project.tasks.map((task) => task.runId)])).toEqual([[boot.id, true, [run.id]]]);
    }
  });

  it('refuses a malformed project id in the query, and answers 404 for an unknown one', async () => {
    await registerProject(repoRoot);
    const malformed = await get('/api/v1/workspace/activity?project=Not:a-slug');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: expect.stringContaining('project') });
    const unknown = await get('/api/v1/workspace/activity?project=no-such-project');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: expect.any(String) });
  });

  it('marks each loaded project it read as watched', async () => {
    const demand = new ActivityDemand();
    const loaded = { id: 'shop', root: '/repo/shop', store, manager } as never;
    const projects = [{ id: 'shop', name: 'Shop', root: '/repo/shop' }, { id: 'docs', name: 'Docs', root: '/repo/docs' }];
    const workspaceProjects = {
      listVisibleProjects: async () => projects,
      resolveBootProject: async () => 'shop',
      resolveLiveProject: async () => loaded,
      projectFailure: () => ({ error: 'unknown project', status: 404 as const }),
    } as unknown as WorkspaceProjects;
    const routes = createActivityRoutes({ bootContext: loaded, contexts: { peek: () => undefined }, workspaceProjects, demand });
    const res = await routes.request('/workspace/activity');
    expect(res.status).toBe(200);
    expect(demand.has('shop')).toBe(true);
    expect(demand.has('docs')).toBe(false);
  });
});
