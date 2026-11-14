import { logPrefix } from '../home/display.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceProject } from '../workspace/config.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { CockpitAlreadyRunningError } from './cockpit-ownership.ts';
import { ProjectContextError, ProjectContexts, type ProjectContext, type ProjectContextDeps } from './project-context.ts';
import type { TaskWebhook } from '../runs/webhook.ts';
import { createTaskWebhooks, createWorkspaceProjectContexts, createWorkspaceProjects } from './workspace-projects.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

const { constructed } = vi.hoisted(() => ({ constructed: [] as ProjectContextDeps[] }));
vi.mock('./project-context.ts', async (original) => {
  const actual = await original<typeof import('./project-context.ts')>();
  return { ...actual, ProjectContexts: class extends actual.ProjectContexts {
    constructor(options: ProjectContextDeps) {
      super(options);
      constructed.push(options);
    }
  } };
});

vi.mock('../workspace/config.ts', async (original) => ({
  ...await original<typeof import('../workspace/config.ts')>(),
  loadWorkspaceConfig: vi.fn(),
}));

const row = (id: string, root = `/repos/${id}`): WorkspaceProject => ({ id, root, name: id, addedAt: '2026-10-30T00:00:00Z', lastOpenedAt: '', source: 'local' });
const workspace = (home = testHome()) => createWorkspaceProjects({ home, bootRoot: '/repos/boot', bootProjectId: 'boot' });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  constructed.length = 0;
});

describe('workspace project identity', () => {
  it('uses the supplied identity without a registry read', async () => {
    expect(await workspace().resolveBootProject()).toBe('boot');
    expect(loadWorkspaceConfig).not.toHaveBeenCalled();
  });

  it('caches registry hits but does not cache fallback slugs', async () => {
    const projects = createWorkspaceProjects({ home: testHome(), bootRoot: '/repos/boot' });
    expect(await projects.resolveBootProject([])).toBe('boot');
    expect(await projects.resolveBootProject([row('registered', '/repos/boot')])).toBe('registered');
    expect(await projects.resolveBootProject([])).toBe('registered');
  });

  it('uses the reserved-name allocator when the registry cannot be read', async () => {
    vi.mocked(loadWorkspaceConfig).mockRejectedValue(new Error('unreadable'));
    expect(await createWorkspaceProjects({ home: testHome(), bootRoot: '/repos/default' }).resolveBootProject()).toBe('default-2');
  });

  it('validates ids before alias resolution and preserves raw malformed-id errors', async () => {
    const projects = workspace();
    expect(await projects.resolveProjectId('default')).toEqual({ id: 'boot' });
    expect(await projects.resolveProjectId('other')).toEqual({ id: 'other' });
    expect(await projects.resolveProjectId('../bad')).toEqual({ error: 'unknown project: ../bad' });
    expect(loadWorkspaceConfig).not.toHaveBeenCalled();
  });
});

describe('project build failure policies', () => {
  const failures = [
    { error: new ProjectContextError('unknown-project', 'other'), expected: { error: 'unknown project: other', status: 404 } },
    { error: new ProjectContextError('missing-root', 'other'), expected: { error: 'project folder not found: other', status: 409 } },
    { error: new RunStoreOpenError('busy', '/runs.db', 'busy'), expected: { status: 409 } },
    { error: new CockpitAlreadyRunningError('/repos/other'), expected: { status: 409 } },
  ] as const;

  it.each(failures)('maps $error.name / $error.message to one answer', ({ error, expected }) => {
    expect(workspace().projectFailure(error, 'other')).toEqual({ error: error.message, ...expected });
  });

  it('answers an unexpected failure with 503 and logs the original error', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cause = new Error('unexpected /secret/path');
    expect(workspace().projectFailure(cause, 'other')).toEqual({ error: 'project unavailable', status: 503 });
    expect(log).toHaveBeenCalledWith(`${logPrefix()} project other context build failed:`, cause);
    log.mockRestore();
  });

  it('suppresses context failures only for the upgrade lookup and never builds malformed ids', async () => {
    const projects = workspace();
    const context = vi.fn().mockRejectedValue(new Error('unexpected'));
    // No boot fields are read here: each request names another project.
    const boot = { home: testHome(),} as ProjectContext;
    projects.bindContexts(boot, { context });
    expect(await projects.lookupProject('../bad')).toBeUndefined();
    expect(context).not.toHaveBeenCalled();
    expect(await projects.lookupProject('other')).toBeUndefined();
    await expect(projects.resolveProject('other')).rejects.toThrow('unexpected');
    await expect(projects.resolveLiveProject('other')).rejects.toThrow('unexpected');
  });

  it('preserves boot identity for HTTP and upgrades but canonicalizes live identity', async () => {
    const projects = workspace();
    const boot = { home: testHome(), id: 'default', dataDir: '/repos/boot/.ai/cezar' } as ProjectContext;
    const context = vi.fn();
    projects.bindContexts(boot, { context });
    expect(await projects.resolveProject('default')).toBe(boot);
    expect(await projects.resolveProject(undefined)).toBe(boot);
    expect(await projects.lookupProject('boot')).toBe(boot);
    expect(await projects.resolveLiveProject('default')).toEqual({ home: boot.home, dataDir: boot.dataDir, id: 'boot' });
    expect(context).not.toHaveBeenCalled();
  });
});

it('keeps injected context and webhook services and builds absent services once', () => {
  const options = { createRunner: noRunners, home: testHome(), listProjects: vi.fn() };
  const contexts = new ProjectContexts(options);
  expect(createWorkspaceProjectContexts({ home: testHome(), manager: { createRunner: noRunners }, contexts }, createTaskWebhooks({ home: testHome(),}), options)).toBe(contexts);
  expect(createWorkspaceProjectContexts({ home: testHome(), manager: { createRunner: noRunners } }, createTaskWebhooks({ home: testHome(),}), options)).toBeInstanceOf(ProjectContexts);
  const webhooks = createTaskWebhooks({ home: testHome(),}, '');
  expect(webhooks.currentOrigin()).toBe('');
  expect(createTaskWebhooks({ home: testHome(),}).currentOrigin()).toBeUndefined();
  expect(createTaskWebhooks({ home: testHome(), taskWebhooks: webhooks })).toBe(webhooks);
});

it('assembles shared context options and keeps prepare/recovery side effects in order', () => {
  const order: string[] = [];
  const detach = vi.fn();
  const webhooks = { attach: () => { order.push('webhooks'); return {} as TaskWebhook; } };
  const delegation = {
    attachProject: () => { order.push('delegation'); return detach; },
    service: { armDestroyRetries: () => { order.push('destroy retries'); } },
  };
  const list = vi.fn();
  createWorkspaceProjectContexts({ home: testHome(), manager: { createRunner: noRunners }, delegation }, webhooks, {
    listProjects: list,
    addressManager: () => { order.push('address'); },
  });
  const options = constructed.at(-1)!;
  expect(options.listProjects).toBe(list);
  const project = { home: testHome(), id: 'other' } as ProjectContext;
  expect(options.prepareManager!(project)).toBe(detach);
  options.afterRecover!(project);
  expect(order).toEqual(['webhooks', 'address', 'delegation', 'destroy retries']);
});

it('removal validates first and reads boot identity only once, including a fallback alias', async () => {
  vi.mocked(loadWorkspaceConfig).mockRejectedValue(new Error('unreadable'));
  const projects = createWorkspaceProjects({ home: testHome(), bootRoot: '/repos/boot' });
  expect(await projects.resolveProjectId('../bad', true)).toEqual({ error: 'unknown project: ../bad' });
  expect(loadWorkspaceConfig).not.toHaveBeenCalled();
  expect(await projects.resolveProjectId('default', true)).toEqual({ id: 'boot', bootId: 'boot' });
  expect(loadWorkspaceConfig).toHaveBeenCalledTimes(1);
});
