import { REBRAND_SWITCH } from './home/switch.ts';
import { lstatSync } from 'node:fs';
import { basename, dirname, join, isAbsolute, relative, resolve } from 'node:path';

/** P4 reads both names immediately. P5 alone changes the write destination. */
export function projectPaths(repoRoot: string) {
  const write = join(repoRoot, '.ai', 'cezar');
  return { write, reads: [write, join(repoRoot, '.ai', 'squawk')] as readonly string[] };
}

/** Non-project data directories (including callers' fixtures) keep their old meaning. */
export function dataReadDirs(dataDir: string): readonly string[] {
  if (basename(dirname(dataDir)) !== '.ai' || !['cezar', 'squawk'].includes(basename(dataDir))) return [dataDir];
  return projectPaths(dirname(dirname(dataDir))).reads;
}

export function dataWriteDir(dataDir: string): string {
  return dataReadDirs(dataDir)[0]!;
}

/** Only absence permits fallback. A damaged, unreadable or dangling legacy item still wins. */
export function pathPresent(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

export function readDataPath(dataDir: string, ...parts: string[]): string {
  const roots = dataReadDirs(dataDir);
  return roots.map(root => join(root, ...parts)).find(pathPresent) ?? join(roots[0]!, ...parts);
}

export function readProjectPath(repoRoot: string, ...parts: string[]): string {
  return readDataPath(projectPaths(repoRoot).write, ...parts);
}

/** Recognize either managed worktree name without changing Git-based repo discovery. */
export const MANAGED_WORKTREE = /(?:^|\/)\.ai\/(?:cezar|squawk)\/worktrees\//;

/** Guard every destructive path, including rows already copied to the legacy database. */
export function isFallbackProjectPath(repoRoot: string, path: string): boolean {
  const inside = relative(resolve(repoRoot, '.ai', 'squawk'), resolve(path));
  return inside === '' || (inside !== '..' && !inside.startsWith('../') && !inside.startsWith('..\\')) && !isAbsolute(inside);
}

/** Existing fallback checkouts and state stay read only after a downgrade. */
export function fallbackProjectWriteError(path: string): string | undefined {
  return /(?:^|[\\/])\.ai[\\/]squawk(?:[\\/]|$)/.test(path)
    ? `Cannot write read-only project data in ${path}. Use the binary that migrated the project.` : undefined;
}

const noticedProjects = new Set<string>();
/** Internal release seam; dual reads themselves do not depend on this flag. */
export function noticeLegacyProject(repoRoot: string, options: { releaseEnabled?: boolean; warn?: (message: string) => void } = {}): void {
  if (!(options.releaseEnabled ?? REBRAND_SWITCH) || noticedProjects.has(repoRoot) || !pathPresent(projectPaths(repoRoot).write)) return;
  noticedProjects.add(repoRoot);
  (options.warn ?? console.warn)(`[cez] Legacy project directory ${projectPaths(repoRoot).write} is still in use; both project directories remain readable.`);
}
