import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
