import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceProject } from '../workspace/config.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { listProjects } from '../workspace/projects.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { CockpitAlreadyRunningError } from './cockpit-ownership.ts';
import { ProjectContextError, ProjectContexts, type ProjectContext } from './project-context.ts';
import { createTaskWebhooks, createWorkspaceProjectContexts, createWorkspaceProjects } from './workspace-projects.ts';

vi.mock('../workspace/config.ts', async (original) => ({
  ...await original<typeof import('../workspace/config.ts')>(),
  loadWorkspaceConfig: vi.fn(),
}));
vi.mock('../workspace/projects.ts', async (original) => ({
  ...await original<typeof import('../workspace/projects.ts')>(),
  listProjects: vi.fn(),
}));

const row = (id: string, root = `/repos/${id}`): WorkspaceProject => ({ id, root, name: id, addedAt: '2026-10-30T00:00:00Z', lastOpenedAt: '', source: 'local' });
const workspace = () => createWorkspaceProjects({ bootRoot: '/repos/boot', bootProjectId: 'boot' });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('workspace project identity', () => {
  it('uses the supplied identity without a registry read', async () => {
    expect(await workspace().resolveBootProject()).toBe('boot');
    expect(loadWorkspaceConfig).not.toHaveBeenCalled();
  });

  it('caches registry hits but does not cache fallback slugs', async () => {
    const projects = createWorkspaceProjects({ bootRoot: '/repos/boot' });
    expect(await projects.resolveBootProject([])).toBe('boot');
    expect(await projects.resolveBootProject([row('registered', '/repos/boot')])).toBe('registered');
    expect(await projects.resolveBootProject([])).toBe('registered');
  });

  it('uses the reserved-name allocator when the registry cannot be read', async () => {
    vi.mocked(loadWorkspaceConfig).mockRejectedValue(new Error('unreadable'));
    expect(await createWorkspaceProjects({ bootRoot: '/repos/default' }).resolveBootProject()).toBe('default-2');
  });

  it('validates ids before alias resolution and preserves raw malformed-id errors', async () => {
    const projects = workspace();
    expect(await projects.resolveProjectId('default')).toEqual({ id: 'boot' });
    expect(await projects.resolveProjectId('other')).toEqual({ id: 'other' });
    expect(await projects.resolveProjectId('../bad')).toEqual({ error: 'unknown project: ../bad' });
    expect(loadWorkspaceConfig).not.toHaveBeenCalled();
  });

  it('reads the visible set live and keeps the list selector at its existing boundary', async () => {
    const projects = workspace();
    const registry = [row('boot'), row('other')];
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    expect(await projects.visibleProjects(registry)).toBe(registry);
    await projects.listVisibleProjects();
    expect(listProjects).toHaveBeenLastCalledWith(undefined);
    vi.stubEnv('CEZ_SINGLE_PROJECT', '1');
    expect(await projects.visibleProjects(registry)).toEqual([registry[0]]);
    await projects.listVisibleProjects();
    expect(listProjects).toHaveBeenLastCalledWith({ projectId: 'boot' });
  });
});

describe('project build failure policies', () => {
  const failures = [
    { error: new ProjectContextError('unknown-project', 'other'), http: 404, live: 404 },
    { error: new ProjectContextError('missing-root', 'other'), http: 409, live: 409 },
    { error: new RunStoreOpenError('busy', '/runs.db', 'busy'), http: 409, live: 409 },
    { error: new CockpitAlreadyRunningError('/repos/other'), http: 409, live: 409 },
  ] as const;

  it.each(failures)('keeps HTTP and live status for $error.name / $error.message', ({ error, http, live }) => {
    const projects = workspace();
    expect(projects.httpFailure(error)?.status).toBe(http);
    expect(projects.liveFailure(error)).toEqual({ error: error.message, status: live });
  });

  it('keeps the distinct missing-root wording and unexpected-error behavior', () => {
    const projects = workspace();
    expect(projects.httpFailure(new ProjectContextError('missing-root', 'other'))).toEqual({ error: 'project folder not found: other', status: 409 });
    expect(projects.httpFailure(new Error('unexpected'))).toBeUndefined();
    expect(projects.liveFailure(new Error('unexpected'))).toEqual({ error: 'run feed unavailable', status: 503 });
  });

  it('suppresses context failures only for the upgrade lookup and never builds malformed ids', async () => {
    const projects = workspace();
    const context = vi.fn().mockRejectedValue(new Error('unexpected'));
    // No boot fields are read here: each request names another project.
    const boot = {} as ProjectContext;
    expect(await projects.lookupProject('../bad', boot, { context })).toBeUndefined();
    expect(context).not.toHaveBeenCalled();
    expect(await projects.lookupProject('other', boot, { context })).toBeUndefined();
    await expect(projects.resolveProject('other', boot, { context })).rejects.toThrow('unexpected');
    await expect(projects.resolveLiveProject('other', boot, { context })).rejects.toThrow('unexpected');
  });

  it('preserves boot identity for HTTP and upgrades but canonicalizes live identity', async () => {
    const projects = workspace();
    const boot = { id: 'default' } as ProjectContext;
    const context = vi.fn();
    expect(await projects.resolveProject('default', boot, { context })).toBe(boot);
    expect(await projects.resolveProject(undefined, boot, { context })).toBe(boot);
    expect(await projects.lookupProject('boot', boot, { context })).toBe(boot);
    expect(await projects.resolveLiveProject('default', boot, { context })).toEqual({ id: 'boot' });
    expect(context).not.toHaveBeenCalled();
  });
});

it('keeps injected context and webhook services and builds absent services once', () => {
  const options = { listProjects: vi.fn() };
  const contexts = new ProjectContexts(options);
  expect(createWorkspaceProjectContexts(contexts, options)).toBe(contexts);
  expect(createWorkspaceProjectContexts(undefined, options)).toBeInstanceOf(ProjectContexts);
  const webhooks = createTaskWebhooks(undefined, { origin: '' });
  expect(createTaskWebhooks(webhooks, {})).toBe(webhooks);
});
