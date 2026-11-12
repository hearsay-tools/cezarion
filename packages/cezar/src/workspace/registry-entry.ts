import { realpath } from 'node:fs/promises';
import type { Home } from '../home/home.ts';
import { loadWorkspaceConfig, type WorkspaceProject } from './config.ts';

/** `id` may be the reserved `default` alias, which resolves to the registry entry holding `root`. */
export async function registryEntry(id: string, root: string, home: Home): Promise<WorkspaceProject | undefined> {
  const projects = (await loadWorkspaceConfig(home.workspaceConfig)).projects;
  const real = id === 'default' ? await realpath(root).catch(() => root) : root;
  return id === 'default'
    ? projects.find((project) => project.root === real || project.root === root)
    : projects.find((project) => project.id === id);
}
