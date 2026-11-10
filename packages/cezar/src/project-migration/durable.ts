import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { syncDirectory } from '../home/private-files.ts';
import { pathPresent } from '../project-paths.ts';

/**
 * The migration's durability invariant, enforced by `settle` alone:
 *
 * (a) After every effect on an entry (created, renamed in or out, rewritten or removed, by the
 *     engine or by Git or SQLite on its behalf), the entry's data when it is a file that was
 *     written, then every directory from its base root down to its parent, are fsynced. This runs
 *     on the first run and on every resume, whether the effect happened now or before a crash.
 * (b) Each step calls `settle` right after the effect and before anything that depends on it: the
 *     next item, a worktree unlock, the step's done mark, the journal's removal.
 *
 * So a power loss never keeps a later action, or the done mark, while losing the effect it
 * depended on. One object, so tests observe each call.
 */
export const durable = {
  directory(path: string): void { syncDirectory(path); },
  file(path: string): void {
    // Windows opens no handle that FlushFileBuffers accepts read-only; its renames are write-through.
    if (process.platform === 'win32') return;
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  },
};

/** `root` and every directory below it down to `path`. */
export function directoriesDown(root: string, path: string): string[] {
  if (path !== root && !path.startsWith(root + sep)) throw new Error(`${path} is not inside ${root}`);
  const directories = [root];
  for (const part of path === root ? [] : path.slice(root.length + 1).split(sep)) directories.push(join(directories.at(-1)!, part));
  return directories;
}

/** Rule (a) for one entry: its data when `data` and it exists, then each directory from `root` down to its parent. */
export function settle(root: string, entry: string, options: { data?: boolean } = {}): void {
  if (options.data && pathPresent(entry)) durable.file(entry);
  for (const directory of directoriesDown(root, dirname(entry))) durable.directory(directory);
}

/** Atomic replacement with exact permission bits: temp file, fsync, rename. The caller settles it. */
export function replaceAtomically(path: string, content: string, mode: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', mode);
  try {
    try { fchmodSync(fd, mode); writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
