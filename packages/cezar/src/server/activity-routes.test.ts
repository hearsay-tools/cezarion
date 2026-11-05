import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activitySnapshotSchema, activityToolSchema } from '@open-mercato/cezar-contract/activity';
import { ActivityDemand } from '../activity/demand.ts';
import { ToolActivityTracker } from '../activity/tool-activity.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { createActivityRoutes } from './activity-routes.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';
import type { WorkspaceProjects } from './workspace-projects.ts';

const TOOL_STATUS = activityToolSchema.shape.status.enum;

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

  it('reads each run’s latest tool and rate from the process’s tool activity tracker', async () => {
    await registerProject(repoRoot);
    const run = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });
    const toolActivity = new ToolActivityTracker();
    toolActivity.observe(run.id, { type: 'item.started', item: { kind: 'tool', id: 'a', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: TOOL_STATUS.running } }, (text) => text);

    const res = await apiRequest(createApp({ repoRoot, store, manager, version: '0.0.0-test', toolActivity }), '/api/v1/workspace/activity?project=default');

    const task = activitySnapshotSchema.parse(await res.json()).projects[0]!.tasks[0]!;
    expect(task.tool).toMatchObject({ title: 'Ran npm test', toolKind: 'execute', status: TOOL_STATUS.running });
    expect(task.rate.reduce((sum, count) => sum + count, 0)).toBe(1);
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

  it('reports a boot store that cannot open as the failure, never as an empty project', async () => {
    const boot = await registerProject(repoRoot);
    store.close();
    const failure = new RunStoreOpenError('unsupported-schema', join(repoRoot, '.ai/cezar', RUNS_DB_FILE), 'runs.db was written by a newer cezar.');
    store = RunStore.unavailable(join(repoRoot, '.ai/cezar'), failure);

    const res = await get('/api/v1/workspace/activity');

    expect(res.status).toBe(200);
    const body = activitySnapshotSchema.parse(await res.json());
    expect(body.projects).toEqual([{ projectId: boot.id, name: boot.name, loaded: true, unavailable: { status: 409, error: failure.message },
      inReview: 0, tasks: [], requests: [], closed: [] }]);
    // The scoped read answers the same failure as its status.
    const scoped = await get(`/api/v1/workspace/activity?project=${boot.id}`);
    expect(scoped.status).toBe(409);
    expect(await scoped.json()).toEqual({ error: failure.message });
  });

  it('keeps an unregistered boot project when the registry reads fine', async () => {
    const other = await registerProject(otherRoot);
    const run = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });
    const contexts = new ProjectContexts({ listProjects });

    const body = activitySnapshotSchema.parse(await (await get('/api/v1/workspace/activity', contexts)).json());

    expect(body.projects.map((project) => [project.name, project.loaded, project.tasks.map((task) => task.runId)]))
      .toEqual([[basename(repoRoot), true, [run.id]], [other.name, false, []]]);
    expect(body.projects[1]!.projectId).toBe(other.id);
    expect(body.projects[0]!.projectId).not.toBe(other.id);
    expect(contexts.ids()).toEqual([]);
    contexts.disposeAll();
  });

  it('keeps the boot project when the registry cannot be read', async () => {
    const run = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });
    const unavailable = { status: 409 as const, error: 'runs.db is damaged' };
    const boot = (over: object) => ({ id: 'default', root: '/repo/shop', manager, ...over }) as never;
    const routesWith = (bootContext: never) => createActivityRoutes({ bootContext, contexts: { peek: () => undefined }, workspaceProjects: {
      listVisibleProjects: async () => { throw new Error('config.json is not JSON'); },
      resolveBootProject: async () => 'shop',
      resolveLiveProject: async () => bootContext,
      projectFailure: () => unavailable,
    } as unknown as WorkspaceProjects });

    const loaded = activitySnapshotSchema.parse(await (await routesWith(boot({ store })).request('/workspace/activity')).json());
    expect(loaded.projects.map((project) => [project.projectId, project.name, project.loaded, project.tasks.map((task) => task.runId)]))
      .toEqual([['shop', 'shop', true, [run.id]]]);

    const failure = new RunStoreOpenError('corrupt', join(repoRoot, '.ai/cezar', RUNS_DB_FILE), 'runs.db is damaged');
    const broken = activitySnapshotSchema.parse(await (await routesWith(boot({ store: RunStore.unavailable(join(repoRoot, '.ai/cezar'), failure) }))
      .request('/workspace/activity')).json());
    expect(broken.projects).toEqual([{ projectId: 'shop', name: 'shop', loaded: true, unavailable, inReview: 0, tasks: [], requests: [], closed: [] }]);
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
