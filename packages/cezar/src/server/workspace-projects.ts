import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { TaskWebhooks } from '../runs/webhook.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { loadWorkspaceConfig, PROJECT_ID_RE, type WorkspaceProject } from '../workspace/config.ts';
import { allocateProjectSlug, listProjects } from '../workspace/projects.ts';
import { resolveCapabilities } from './capabilities.ts';
import { CockpitAlreadyRunningError } from './cockpit-ownership.ts';
import type { ServerDeps } from './server.ts';
import { ProjectContextError, ProjectContexts, type ProjectContext, type ProjectContextDeps } from './project-context.ts';

type ContextServices = Pick<ServerDeps, 'contexts' | 'semaphore' | 'previewHost' | 'forgeFactory'> & {
  delegation?: Pick<NonNullable<ServerDeps['delegation']>, 'attachProject'> & {
    service: Pick<NonNullable<ServerDeps['delegation']>['service'], 'armDestroyRetries'>;
  };
};

/** Assemble the shared lazy-context wiring once; entry points supply only their differences. */
export function createWorkspaceProjectContexts(
  deps: ContextServices,
  taskWebhooks: Pick<TaskWebhooks, 'attach'>,
  options: Pick<ProjectContextDeps, 'listProjects' | 'ownership' | 'automationStore' | 'cezarPort'> & {
    addressManager?: (project: Parameters<NonNullable<ProjectContextDeps['prepareManager']>>[0]) => void;
  },
): ProjectContexts {
  // Both entry points supply the visible registry (hearsay-tools/cezarion#2320).
  return deps.contexts ?? new ProjectContexts({
    forgeFactory: deps.forgeFactory,
    ...options,
    semaphore: deps.semaphore,
    preview: deps.previewHost,
    prepareManager: (project) => {
      taskWebhooks.attach(project);
      options.addressManager?.(project);
      return deps.delegation?.attachProject(project);
    },
    afterRecover: (project) => deps.delegation?.service.armDestroyRetries(project.id),
  });
}

/** createApp supplies an empty origin; startServer leaves origin absent until listen. */
export function createTaskWebhooks(
  deps: Pick<ServerDeps, 'taskWebhooks' | 'taskWebhookFetch'>,
  origin?: string,
): TaskWebhooks {
  return deps.taskWebhooks ?? new TaskWebhooks({
    fetch: deps.taskWebhookFetch,
    ...(origin === undefined ? {} : { origin }),
  });
}

/** The same boundary gate for scoped requests and registry edits; never touches a path or map. */
const projectIdSchema = z.union([z.literal('default'), z.string().regex(PROJECT_ID_RE)]);

function classifyProjectBuildFailure(error: unknown) {
  if (error instanceof CockpitAlreadyRunningError) return { kind: 'cockpit-owned', error } as const;
  if (error instanceof RunStoreOpenError) return { kind: 'store-unavailable', error } as const;
  if (error instanceof ProjectContextError) return { kind: error.reason, error } as const;
  return { kind: 'unexpected', error } as const;
}

/** Workspace identity and lookup rules shared by HTTP, live feeds, upgrades and registry edits. */
export function createWorkspaceProjects(options: { bootRoot: string; bootProjectId?: string | undefined; bindHost?: string | undefined }) {
  const { bootRoot, bootProjectId, bindHost } = options;
  // ---- workspace boot-project identity (multi-project spec) ----------------
  // The boot flow (`initWorkspace` in src/index.ts) registers the boot repo
  // and plumbs its registry id in via `deps.bootProjectId`. Legacy callers and
  // tests construct the app without one — then it is derived lazily from the
  // registry by realpath and cached on a hit. A boot repo that is legitimately
  // unregistered (task worktree, `$HOME` itself, unreadable workspace) falls
  // back to its would-be slug, so `bootProject` always names the repo this
  // server was started in. Strictly non-fatal, zero-config: every failure path
  // degrades to the slug fallback, never an error.
  let bootProjectCache = bootProjectId;
  const resolveBootProject = async (projects?: readonly WorkspaceProject[]): Promise<string> => {
    if (bootProjectCache) return bootProjectCache;
    let registry = projects ?? [];
    try {
      registry = projects ?? (await loadWorkspaceConfig()).projects;
      const real = await realpath(bootRoot).catch(() => bootRoot);
      const match = registry.find((p) => p.root === real || p.root === bootRoot);
      if (match) bootProjectCache = match.id;
    } catch {
      // unreadable workspace — fall through to the slug fallback below
    }
    return bootProjectCache ?? allocateProjectSlug(bootRoot, registry.map((project) => project.id));
  };
  const canonicalProjectId = async (raw: string): Promise<string> => raw === 'default' ? await resolveBootProject() : raw;
  const validProjectId = (raw: string): boolean => projectIdSchema.safeParse(raw).success;
  const resolveProjectId = async (raw: string, removal = false): Promise<{ id: string; bootId?: string } | { error: string }> => {
    if (!validProjectId(raw)) return { error: `unknown project: ${raw}` };
    // Removal also needs boot identity for its refusal; resolve it once, after validation.
    if (removal) {
      const bootId = await resolveBootProject();
      return { id: raw === 'default' ? bootId : raw, bootId };
    }
    return { id: await canonicalProjectId(raw) };
  };
  const singleProject = () => resolveCapabilities(process.env, bindHost).singleProject;
  const visibleRegistry = async <T extends { id: string }>(registry: readonly T[], resolvedBootId?: string): Promise<readonly T[]> => {
    if (!singleProject()) return registry;
    const bootId = resolvedBootId ?? await resolveBootProject();
    return registry.filter((project) => project.id === bootId);
  };
  const projectSelector = async () => singleProject() ? { projectId: await resolveBootProject() } : undefined;
  const listVisibleProjects = async () => listProjects(await projectSelector());
  const registryEntry = async (projectId: string): Promise<WorkspaceProject | undefined> => {
    const id = await canonicalProjectId(projectId);
    return (await loadWorkspaceConfig()).projects.find((entry) => entry.id === id);
  };
  const resolveRegistryEntry = async (raw: string): Promise<WorkspaceProject | undefined> => {
    if (!validProjectId(raw)) return undefined;
    return registryEntry(raw).catch(() => undefined);
  };
  // Identity precedes the lazy context supplier; createApp binds its completed contexts once.
  let boundBoot: ProjectContext;
  let boundContexts: Pick<ProjectContexts, 'context'>;
  const bindContexts = (boot: ProjectContext, contexts: Pick<ProjectContexts, 'context'>): void => {
    boundBoot = boot;
    boundContexts = contexts;
  };
  const resolveProject = async (raw: string | undefined): Promise<ProjectContext> => {
    if (raw === undefined) return boundBoot;
    if (!validProjectId(raw)) throw new ProjectContextError('unknown-project', raw);
    if (raw === 'default' || raw === (await resolveBootProject())) return boundBoot;
    return boundContexts.context(raw);
  };
  const lookupProject = async (raw: string | undefined) => {
    // Upgrades suppress all build failures; HTTP and live feeds answer them through projectFailure.
    if (raw === undefined || raw === 'default' || raw === (await resolveBootProject())) return boundBoot;
    if (!validProjectId(raw)) return undefined;
    return boundContexts.context(raw).catch(() => undefined);
  };
  const resolveLiveProject = async (id: string) => {
    const bootId = await resolveBootProject();
    if (id === 'default' || id === bootId) return { ...boundBoot, id: bootId };
    return boundContexts.context(id);
  };
  // One answer per context failure for HTTP and live feeds (hearsay-tools/cezarion#2321).
  const projectFailure = (error: unknown, projectId: string): { error: string; status: 404 | 409 | 503 } => {
    const failure = classifyProjectBuildFailure(error);
    if (failure.kind === 'unexpected') {
      console.error(`[cez] project ${projectId} context build failed:`, error);
      return { error: 'project unavailable', status: 503 };
    }
    if (failure.kind === 'missing-root') return { error: `project folder not found: ${failure.error.projectId}`, status: 409 };
    return { error: failure.error.message, status: failure.kind === 'unknown-project' ? 404 : 409 };
  };
  return { resolveBootProject, canonicalProjectId, resolveProjectId, singleProject, visibleProjects: visibleRegistry,
    listVisibleProjects, registryEntry, resolveRegistryEntry, resolveProject, bindContexts, lookupProject, resolveLiveProject, projectFailure };
}

export type WorkspaceProjects = ReturnType<typeof createWorkspaceProjects>;
