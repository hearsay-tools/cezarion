/** Optional overrides stay absent until explicitly saved. */
export function resolveArchiveOnMerge(
  project: { archiveOnMerge?: boolean | undefined },
  workspace: { archiveOnMerge?: boolean | undefined },
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: 'project' | 'global' | 'environment' | 'default' } {
  if (typeof project.archiveOnMerge === 'boolean') return { enabled: project.archiveOnMerge, source: 'project' };
  return resolveGlobalArchiveOnMerge(workspace, env);
}

export function resolveGlobalArchiveOnMerge(
  workspace: { archiveOnMerge?: boolean | undefined },
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: 'global' | 'environment' | 'default' } {
  if (typeof workspace.archiveOnMerge === 'boolean') return { enabled: workspace.archiveOnMerge, source: 'global' };
  if (env.CEZ_ARCHIVE_ON_MERGE === '1') return { enabled: true, source: 'environment' };
  return { enabled: false, source: 'default' };
}
