import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canStartFreshProject, pathPresent, projectMovedMarker, projectMoveMarked } from '../project-paths.ts';
import { replaceAtomically, settle } from './durable.ts';

/** Pin a fresh project's new write root before its first write. Any legacy path, including an
 * empty directory, symlink or unreadable entry, keeps the existing migration rules. Reads of
 * projectPaths stay pure. The marker uses the same private Git location as a completed move. */
export function markFreshProject(root: string): void {
  if (!canStartFreshProject(root) || projectMoveMarked(root)) return;
  const marker = projectMovedMarker(root);
  // Non-Git callers still use the fresh path; there is no Git marker location to write.
  if (!marker) return;
  const directory = dirname(marker.path);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  if (!lstatSync(directory).isDirectory()) throw new Error(`${directory} is not a directory`);
  if (pathPresent(marker.path) && !lstatSync(marker.path).isFile()) throw new Error(`${marker.path} is not a regular file`);
  replaceAtomically(marker.path, `${JSON.stringify({ version: 1, root: marker.root, from: join(marker.root, '.ai/cezar') })}\n`, 0o600);
  settle(dirname(directory), marker.path, { data: true });
}
