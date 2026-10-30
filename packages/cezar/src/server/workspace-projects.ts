import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { TaskWebhooks } from '../runs/webhook.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import { loadWorkspaceConfig, PROJECT_ID_RE, type WorkspaceProject } from '../workspace/config.ts';
import { allocateProjectSlug, listProjects } from '../workspace/projects.ts';
import { resolveCapabilities } from './capabilities.ts';
import { CockpitAlreadyRunningError } from './cockpit-ownership.ts';
import { ProjectContextError, ProjectContexts, type ProjectContext, type ProjectContextDeps } from './project-context.ts';

/** One construction site, with each entry point's original ordered options and injected map. */
export function createWorkspaceProjectContexts(injected: ProjectContexts | undefined, options: ProjectContextDeps): ProjectContexts {
  // createApp supplies a filtered registry; startServer deliberately supplies the full registry.
  return injected ?? new ProjectContexts(options);
}

/** createApp supplies an empty origin; startServer leaves origin absent until listen. */
export function createTaskWebhooks(injected: TaskWebhooks | undefined, options: ConstructorParameters<typeof TaskWebhooks>[0]): TaskWebhooks {
  return injected ?? new TaskWebhooks(options);
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
  // A registry hit is cached. A slug fallback is not: registration may succeed on a later read.
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
  const resolveProjectId = async (raw: string): Promise<{ id: string } | { error: string }> =>
    validProjectId(raw) ? { id: await canonicalProjectId(raw) } : { error: `unknown project: ${raw}` };
  const singleProject = () => resolveCapabilities(process.env, bindHost).singleProject;
  const visibleRegistry = async <T extends { id: string }>(registry: readonly T[]): Promise<readonly T[]> => {
    if (!singleProject()) return registry;
    const bootId = await resolveBootProject();
    return registry.filter((project) => project.id === bootId);
  };
  const projectSelector = async () => singleProject() ? { projectId: await resolveBootProject() } : undefined;
  const listVisibleProjects = async () => listProjects(await projectSelector());
  const registryEntry = async (projectId: string): Promise<WorkspaceProject | undefined> => {
    const id = await canonicalProjectId(projectId);
    return (await loadWorkspaceConfig()).projects.find((entry) => entry.id === id);
  };
  const resolveProject = async (raw: string | undefined, boot: ProjectContext, contexts: Pick<ProjectContexts, 'context'>): Promise<ProjectContext> => {
    if (raw === undefined) return boot;
    if (!validProjectId(raw)) throw new ProjectContextError('unknown-project', raw);
    if (raw === 'default' || raw === (await resolveBootProject())) return boot;
    return contexts.context(raw);
  };
  const lookupProject = async (raw: string | undefined, boot: ProjectContext, contexts: Pick<ProjectContexts, 'context'>) => {
    // Upgrades suppress all build failures; HTTP rethrows unexpected failures, live feeds use 503.
    if (raw === undefined || raw === 'default' || raw === (await resolveBootProject())) return boot;
    if (!validProjectId(raw)) return undefined;
    return contexts.context(raw).catch(() => undefined);
  };
  const resolveLiveProject = async (id: string, boot: ProjectContext, contexts: Pick<ProjectContexts, 'context'>) => {
    const bootId = await resolveBootProject();
    if (id === 'default' || id === bootId) return { ...boot, id: bootId };
    return contexts.context(id);
  };
  const httpFailure = (error: unknown): { error: string; status: 404 | 409 } | undefined => {
    const failure = classifyProjectBuildFailure(error);
    if (failure.kind === 'unexpected') return undefined;
    // HTTP calls this a folder; live feeds preserve ProjectContextError's original root wording.
    if (failure.kind === 'missing-root') return { error: `project folder not found: ${failure.error.projectId}`, status: 409 };
    return { error: failure.error.message, status: failure.kind === 'unknown-project' ? 404 : 409 };
  };
  const liveFailure = (error: unknown): { error: string; status: 404 | 409 | 503 } => {
    const failure = classifyProjectBuildFailure(error);
    if (failure.kind === 'unexpected') return { error: 'run feed unavailable', status: 503 };
    return { error: failure.error.message, status: failure.kind === 'unknown-project' ? 404 : 409 };
  };
  return { resolveBootProject, canonicalProjectId, resolveProjectId, singleProject, visibleProjects: visibleRegistry,
    listVisibleProjects, registryEntry, resolveProject, lookupProject, resolveLiveProject, httpFailure, liveFailure };
}

export type WorkspaceProjects = ReturnType<typeof createWorkspaceProjects>;
