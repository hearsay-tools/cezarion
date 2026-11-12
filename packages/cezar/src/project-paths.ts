import { productIdentity } from './home/identity.ts';
import { REBRAND_SWITCH } from './home/switch.ts';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, isAbsolute, relative, resolve } from 'node:path';
import { legacyRunItem } from './legacy-runs.ts';
export { runDataDir } from './legacy-runs.ts';

/**
 * Where a completed project migration marks the project moved (hearsay-tools/cezarion#3150):
 * `<git common dir>/cezar-moved-projects/<sha256 of the project's real root>.json`, naming that
 * root. A commit, clone or pull never writes inside the Git directory, so a repository cannot ship
 * or forge the mark; a linked checkout registered as its own project has its own key.
 */
export const MOVED_PROJECTS_DIR = 'cezar-moved-projects';

/** The Git common directory of the checkout at `root`, read from `.git` without running Git. */
function commonDirOf(root: string): string | undefined {
  const dotGit = join(root, '.git');
  try {
    let admin = dotGit;
    if (statSync(dotGit).isFile()) {
      const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8').slice(0, 4096))?.[1]?.trim();
      if (!gitdir) return undefined;
      admin = resolve(root, gitdir);
    }
    let common = admin;
    try { common = resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined; }
    return realpathSync(common);
  } catch { return undefined; }
}

const markers = new Map<string, { root: string; path: string }>();
/** The project's real root and its moved marker path; undefined when its Git directory is not found. */
export function projectMovedMarker(repoRoot: string): { root: string; path: string } | undefined {
  const cached = markers.get(repoRoot);
  if (cached) return cached;
  let root: string;
  try { root = realpathSync(repoRoot); } catch { return undefined; }
  const common = commonDirOf(root);
  if (!common) return undefined;
  const marker = { root, path: join(common, MOVED_PROJECTS_DIR, `${createHash('sha256').update(root).digest('hex')}.json`) };
  markers.set(repoRoot, marker);
  return marker;
}

/** Whether the project's migration has completed: its marker is a regular file that names this root. */
export function projectMoveMarked(repoRoot: string): boolean {
  const marker = projectMovedMarker(repoRoot);
  if (!marker) return false;
  try {
    if (!lstatSync(marker.path).isFile()) return false;
    return (JSON.parse(readFileSync(marker.path, 'utf8')) as { root?: unknown }).root === marker.root;
  } catch { return false; }
}

/** A directory entry itself must be a directory; never follow a symlink. */
export function realDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/** Shared by fresh writes and migration planning: an absent or real directory is safe. */
export function projectDestinationAvailable(path: string): boolean {
  return !pathPresent(path) || realDirectory(path);
}

/** Fresh selection never promotes an existing fallback symlink or file into a write root. */
export function canStartFreshProject(root: string): boolean {
  return !pathPresent(join(root, '.ai/cezar')) && projectDestinationAvailable(join(root, '.ai/squawk'));
}

/**
 * The one rule for a project's write root. With the release switch on, a moved project writes
 * `.ai/squawk/` and reads `.ai/cezar/` as its fallback. A fresh project (no legacy path) does
 * the same from its first use when the destination is absent or a real directory; every existing legacy project, and every project
 * with the switch off, writes `.ai/cezar/` and reads `.ai/squawk/` as its fallback. With the
 * switch on: marker and legacy-path checks; none with it off. Reads never create a marker.
 */
export function projectPaths(repoRoot: string) {
  const legacy = join(repoRoot, '.ai', 'cezar');
  const moved = join(repoRoot, '.ai', 'squawk');
  const write = REBRAND_SWITCH && (projectMoveMarked(repoRoot) || canStartFreshProject(repoRoot)) ? moved : legacy;
  return { write, reads: [write, write === legacy ? moved : legacy] as readonly string[] };
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

/** Guard every destructive path, including rows already copied to the write root's database. An
 *  item a task kept in `.ai/cezar/` at the project move (`legacy-runs.ts`) is not guarded. */
export function isFallbackProjectPath(repoRoot: string, path: string): boolean {
  const inside = relative(resolve(projectPaths(repoRoot).reads[1]!), resolve(path));
  const fallback = inside === '' || (inside !== '..' && !inside.startsWith('../') && !inside.startsWith('..\\')) && !isAbsolute(inside);
  return fallback && !legacyRunItem(repoRoot, path);
}

/**
 * Existing fallback checkouts and state stay read only: a path inside the fallback directory of
 * the project that holds it, as `projectPaths` of that project decides. An absent recorded
 * project root is not fallback state with the switch on: missing-checkout callers keep their normal fallback.
 */
export function fallbackProjectWriteError(path: string): string | undefined {
  for (const match of path.matchAll(/(?:^|[\\/])\.ai[\\/](cezar|squawk)(?=[\\/]|$)/g)) {
    const root = path.slice(0, match.index) || '.';
    if (REBRAND_SWITCH && !pathPresent(root)) continue;
    if (basename(projectPaths(root).reads[1]!) !== match[1]) continue;
    // A kept task's own items stay in `.ai/cezar/` after the move, and stay writable.
    if (match[1] === 'cezar' && legacyRunItem(root, path)) continue;
    return `Cannot write read-only project data in ${path}. Use the binary that migrated the project.`;
  }
  return undefined;
}

/**
 * Where a project migration moved `path`, a path under `<root>/.ai/cezar/`: the first component
 * that is gone from the old directory and present under `.ai/squawk/` marks the move. Undefined
 * when nothing moved it. A CLI write to a path it was handed before the migration (a task's
 * `CEZ_ARTIFACTS_DIR`) checks this first, so it never recreates a moved directory.
 */
export function movedProjectPath(path: string): string | undefined {
  const parts = resolve(path).split(/[\\/]/);
  const at = parts.lastIndexOf('cezar');
  if (at < 1 || parts[at - 1] !== '.ai') return undefined;
  for (let end = at + 1; end < parts.length; end++) {
    const old = parts.slice(0, end + 1).join('/'), moved = [...parts.slice(0, at), 'squawk', ...parts.slice(at + 1, end + 1)].join('/');
    if (pathPresent(old)) continue;
    return pathPresent(moved) ? [...parts.slice(0, at), 'squawk', ...parts.slice(at + 1)].join('/') : undefined;
  }
  return undefined;
}

const noticedProjects = new Set<string>();
/** Internal release seam; dual reads themselves do not depend on this flag. */
export function noticeLegacyProject(repoRoot: string, options: { releaseEnabled?: boolean; reason?: string; warn?: (message: string) => void } = {}): void {
  const legacy = join(repoRoot, '.ai', 'cezar');
  if (!(options.releaseEnabled ?? REBRAND_SWITCH) || (noticedProjects.has(repoRoot) && !options.reason) || projectPaths(repoRoot).write !== legacy || !pathPresent(legacy)) return;
  noticedProjects.add(repoRoot);
  const prefix = productIdentity(options.releaseEnabled ?? REBRAND_SWITCH).command;
  const message = options.reason
    ? `Project ${repoRoot} keeps its state in .ai/cezar/ for now: ${options.reason}. It is served from both folders; the move runs again at the next start.`
    : `Legacy project directory ${legacy} is still in use; both project directories remain readable.`;
  (options.warn ?? console.warn)(`[${prefix}] ${message}`);
}
